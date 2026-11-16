// services/analytics/activity.js
// Shared building blocks for admin figures, so the metrics page, the overview, the engagement page and the
// dashboard count the same way (accountRules.js decides who counts).
//   activeStudents({ since, to, rule })  students whose last activity in the app is in [since, to]: existing,
//                                         not test accounts, role student → [{ user, lastActiveAt, university }]
//   userCounts(rule)                      per role: active (not suspended / banned / deactivated), suspended,
//                                         includingSuspended — test accounts never counted
const User = require("../../models/User");
const EngagementProfile = require("../../models/EngagementProfile");
const { realUserFilter, NOT_ACTIVE } = require("./accountRules");

async function activeStudents({ since, to = null, rule }) {
  const when = { $gte: since, ...(to ? { $lte: to } : {}) };
  const profiles = await EngagementProfile.find({ "stats.lastActiveAt": when }).select("user stats.lastActiveAt").lean();
  const students = new Map((await User.find({ _id: { $in: profiles.map((p) => p.user) }, role: "student", ...realUserFilter(rule) }).select("_id university").lean()).map((u) => [String(u._id), u]));
  return profiles.filter((p) => students.has(String(p.user))).map((p) => ({ user: String(p.user), lastActiveAt: new Date(p.stats.lastActiveAt), university: students.get(String(p.user)).university || null }));
}

const ROLES = ["student", "brand", "employee", "traveler"];
async function userCounts(rule) {
  const real = realUserFilter(rule);
  const out = {};
  for (const role of ROLES) {
    const includingSuspended = await User.countDocuments({ role, ...real });
    const suspended = await User.countDocuments({ role, accountStatus: { $in: NOT_ACTIVE }, ...real });
    out[role] = { active: includingSuspended - suspended, suspended, includingSuspended };
  }
  return out;
}

module.exports = { activeStudents, userCounts, ROLES };

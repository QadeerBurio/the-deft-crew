// services/analytics/accountRules.js
// Who counts in admin figures, the same everywhere (metrics, overview, brand revenue, engagement, user counts):
//   - deleted accounts: their user record is gone (services/accountDeletion.js replaces their id with a random
//     placeholder stored nowhere), so a row counts only if its account still exists
//   - test accounts: Railway variables (no schema field): METRICS_TEST_EMAILS (comma list),
//     METRICS_TEST_EMAIL_DOMAINS (e.g. "tdc.test,example.com"), METRICS_TEST_USER_IDS. Not set = nobody excluded.
//   - suspended accounts (user counts only): accountStatus suspended / banned / deactivated
const mongoose = require("mongoose");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const listEnv = (k) => String(process.env[k] || "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const NOT_ACTIVE = ["suspended", "banned", "deactivated"];

/** the test-account rule from the Railway variables (read on each call) */
function testRule() {
  return { emails: new Set(listEnv("METRICS_TEST_EMAILS")), domains: listEnv("METRICS_TEST_EMAIL_DOMAINS").map((d) => d.replace(/^@/, "")), ids: new Set(listEnv("METRICS_TEST_USER_IDS")) };
}
const ruleConfigured = (rule) => rule.emails.size + rule.domains.length + rule.ids.size > 0;
function isTestUser(u, rule) {
  const email = String(u?.email || "").toLowerCase();
  return rule.ids.has(String(u?._id).toLowerCase()) || (!!email && (rule.emails.has(email) || rule.domains.some((d) => email.endsWith(`@${d}`))));
}
/** a Mongo filter for real (not test) accounts on the User collection */
function realUserFilter(rule) {
  const nor = [];
  if (rule.ids.size) nor.push({ _id: { $in: [...rule.ids].filter(isId) } });
  if (rule.emails.size) nor.push({ email: { $in: [...rule.emails] } });
  for (const d of rule.domains) nor.push({ email: { $regex: `@${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
  return nor.length ? { $nor: nor } : {};
}
/** from some account ids, the ones that still exist and aren't test accounts */
async function liveIds(ids, rule) {
  const User = require("../../models/User");
  const uniq = [...new Set(ids.map(String).filter(isId))];
  if (!uniq.length) return new Set();
  const users = await User.find({ _id: { $in: uniq } }).select("_id email").lean();
  return new Set(users.filter((u) => !isTestUser(u, rule)).map((u) => String(u._id)));
}
/** the ids of test accounts among existing users (for $nin filters on other collections) */
async function testIds(rule) {
  if (!ruleConfigured(rule)) return [];
  const User = require("../../models/User");
  const nor = realUserFilter(rule).$nor;
  return (await User.find({ $or: nor }).select("_id").lean()).map((u) => u._id);
}

module.exports = { isId, testRule, ruleConfigured, isTestUser, realUserFilter, liveIds, testIds, NOT_ACTIVE };

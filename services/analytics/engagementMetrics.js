// services/analytics/engagementMetrics.js
// The admin engagement page (GET /api/admin/engagement/metrics?weeks=N), on the same rules as the metrics page:
//   - the range is the last N weeks in whole Karachi days (today included); every count follows it
//   - Karachi time for "exam mode active" (today's Karachi day) and the weekly chart (Karachi days → Mon–Sun weeks)
//   - test accounts (accountRules.js) are left out everywhere; deleted accounts have no profile / user any more
//   - push "sent" = delivered (the push service confirmed it: deliveredAt); failed and queued are separate, and
//     "sent, no receipt yet" too, so they add up to every push in the range
//   - rewards "redeemed" = codes used at the brand in the range; "codes issued" = codes students took in the range
//   - referrals: "students who invited someone" (someone signed up with their code, all time); "invited sign-ups"
//     = accounts created in the range with an invite code. Nothing records an invite being shared, so a count of
//     invites *sent* doesn't exist.
// Names of the response fields are kept (the portal reads them); the new ones are added.
const DailyDrop = require("../../models/DailyDrop");
const DropReaction = require("../../models/DropReaction");
const RewardRedemption = require("../../models/RewardRedemption");
const EngagementProfile = require("../../models/EngagementProfile");
const EngagementEvent = require("../../models/EngagementEvent");
const UserBadge = require("../../models/UserBadge");
const PointsLedger = require("../../models/PointsLedger");
const PushLog = require("../../models/PushLog");
const User = require("../../models/User");
const { dayKey } = require("../../utils/karachiTime");
const { testRule, testIds, realUserFilter, ruleConfigured, liveIds } = require("./accountRules");
const { activeStudents } = require("./activity");

const DAY = 864e5;
const TZ = "Asia/Karachi";

/** the range: the last `weeks` weeks as whole Karachi days ending today */
function weeksRange(weeks, now = new Date()) {
  const w = Math.min(Math.max(parseInt(weeks, 10) || 8, 1), 26);
  const todayStart = new Date(`${dayKey(now)}T00:00:00+05:00`);
  return { weeks: w, since: new Date(todayStart.getTime() - (w * 7 - 1) * DAY), to: now, fromDay: dayKey(new Date(todayStart.getTime() - (w * 7 - 1) * DAY)), toDay: dayKey(now) };
}

/** ISO week (Monday start) of a Karachi day "YYYY-MM-DD" → { year, week, weekStart } */
function isoWeekOf(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  const monday = new Date(d.getTime() - dow * DAY);
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY);
  return { year, week: Math.round((monday - week1Monday) / (7 * DAY)) + 1, weekStart: monday.toISOString().slice(0, 10) };
}
/** [{ _id: "YYYY-MM-DD" (Karachi), users: [ids] }] → [{ _id: { week, year }, weekStart, users: n }] distinct per week */
function weeklyFromDays(dayRows, exclude = new Set()) {
  const weeks = new Map();
  for (const row of dayRows) {
    const w = isoWeekOf(row._id);
    const k = w.weekStart;
    if (!weeks.has(k)) weeks.set(k, { w, users: new Set() });
    for (const u of row.users || []) if (!exclude.has(String(u))) weeks.get(k).users.add(String(u));
  }
  return [...weeks.values()].sort((a, b) => (a.w.weekStart < b.w.weekStart ? -1 : 1)).map(({ w, users }) => ({ _id: { week: w.week, year: w.year }, weekStart: w.weekStart, users: users.size }));
}

async function engagementMetrics({ weeks } = {}, { now = new Date(), rule = testRule() } = {}) {
  const r = weeksRange(weeks, now);
  const since = r.since;
  const test = await testIds(rule);
  const testSet = new Set(test.map(String));
  const notTestMatch = test.length ? { user: { $nin: test } } : {};
  const inRange = { $gte: since, $lte: now };

  const profilesAll = await EngagementProfile.countDocuments({});
  const profilesTest = test.length ? await EngagementProfile.countDocuments({ user: { $in: test } }) : 0;
  const active = await activeStudents({ since, to: now, rule });

  const pushBase = { sentAt: inRange, ...notTestMatch };
  const pushDelivered = await PushLog.countDocuments({ ...pushBase, deliveredAt: { $ne: null } });
  const pushFailed = await PushLog.countDocuments({ ...pushBase, status: "failed" });
  const pushQueued = await PushLog.countDocuments({ ...pushBase, status: "queued" });
  const pushAwaitingReceipt = await PushLog.countDocuments({ ...pushBase, status: "sent", deliveredAt: null });
  const pushOpened = await PushLog.countDocuments({ ...pushBase, openedAt: { $ne: null } });

  // referrals: who invited, from the accounts that signed up with a code (the counter on the user can drift)
  const referred = await User.find({ referredBy: { $ne: null }, ...realUserFilter(rule) }).select("referredBy createdAt").lean();
  const inviters = await liveIds(referred.map((u) => u.referredBy), rule);
  const invitedSignups = referred.filter((u) => u.createdAt >= since && u.createdAt <= now && inviters.has(String(u.referredBy))).length;

  // weekly users: distinct users per Karachi day (the database groups by the Karachi date), folded into weeks
  const days = await EngagementEvent.aggregate([
    { $match: { createdAt: inRange, ...notTestMatch } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } }, users: { $addToSet: "$user" } } },
    { $sort: { _id: 1 } },
  ]);
  const [missionAgg, levelAgg, topBadgesAgg, eventBreakdownAgg, pointsAgg, streakAgg] = await Promise.all([
    EngagementProfile.aggregate([
      { $match: notTestMatch },
      { $group: {
        _id: null,
        discounts: { $sum: { $cond: [{ $ne: ["$sorted.discounts", null] }, 1, 0] } },
        resume: { $sum: { $cond: [{ $ne: ["$sorted.resume", null] }, 1, 0] } },
        jobs: { $sum: { $cond: [{ $ne: ["$sorted.jobs", null] }, 1, 0] } },
        social: { $sum: { $cond: [{ $ne: ["$sorted.social", null] }, 1, 0] } },
        events: { $sum: { $cond: [{ $ne: ["$sorted.events", null] }, 1, 0] } },
        scholarship: { $sum: { $cond: [{ $ne: ["$sorted.scholarship", null] }, 1, 0] } },
        skillshare: { $sum: { $cond: [{ $ne: ["$sorted.skillshare", null] }, 1, 0] } },
        traveling: { $sum: { $cond: [{ $ne: ["$sorted.traveling", null] }, 1, 0] } },
      } },
    ]),
    EngagementProfile.aggregate([{ $match: notTestMatch }, { $group: { _id: "$level.id", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    UserBadge.aggregate([{ $match: { earnedAt: inRange, ...notTestMatch } }, { $group: { _id: "$badgeId", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
    EngagementEvent.aggregate([{ $match: { createdAt: inRange, ...notTestMatch } }, { $group: { _id: "$name", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 20 }]),
    PointsLedger.aggregate([{ $match: { createdAt: inRange, delta: { $gt: 0 }, ...notTestMatch } }, { $group: { _id: null, total: { $sum: "$delta" } } }]),
    EngagementProfile.aggregate([{ $match: notTestMatch }, { $group: { _id: null, avgStreak: { $avg: "$streak.count" }, longestStreak: { $max: "$streak.best" } } }]),
  ]);

  const missionBreakdown = missionAgg[0] ? Object.fromEntries(Object.entries(missionAgg[0]).filter(([k]) => k !== "_id").map(([k, v]) => [k, v || 0])) : {};
  const levelBreakdown = {};
  levelAgg.forEach((row) => { levelBreakdown[row._id || "member"] = row.count; });
  const eventBreakdown = {};
  eventBreakdownAgg.forEach((row) => { eventBreakdown[row._id] = row.count; });
  const streakStats = streakAgg[0] || { avgStreak: 0, longestStreak: 0 };
  const rewardsUsed = await RewardRedemption.countDocuments({ status: "used", usedAt: inRange, ...notTestMatch });
  const codesIssued = await RewardRedemption.countDocuments({ createdAt: inRange, ...notTestMatch });

  return {
    range: { weeks: r.weeks, fromDay: r.fromDay, toDay: r.toDay, timeZone: TZ },
    exclusions: { test: ruleConfigured(rule) ? "test accounts left out (METRICS_TEST_* variables)" : "no test accounts set up yet" },
    totalProfiles: profilesAll - profilesTest,
    activeUsers: active.length,
    badgesEarned: await UserBadge.countDocuments({ earnedAt: inRange, ...notTestMatch }),
    pushSent: pushDelivered, pushDelivered, pushFailed, pushQueued, pushAwaitingReceipt, pushOpened,
    pushOpenRate: pushDelivered > 0 ? pushOpened / pushDelivered : 0,
    rewardsRedeemed: rewardsUsed, codesIssued,
    totalDrops: await DailyDrop.countDocuments({ createdAt: inRange }),
    totalDropReactions: await DropReaction.countDocuments({ createdAt: inRange, ...notTestMatch }),
    totalPointsAwarded: pointsAgg[0]?.total || 0,
    fullySortedCount: await EngagementProfile.countDocuments({ sortedCount: 8, ...notTestMatch }),
    examModeActive: await EngagementProfile.countDocuments({ "streak.examModeUntil": { $gte: dayKey(now) }, ...notTestMatch }),
    totalReferrals: inviters.size, studentsWhoInvited: inviters.size, invitedSignups,
    avgStreak: streakStats.avgStreak || 0,
    longestStreak: streakStats.longestStreak || 0,
    weeklyUsers: weeklyFromDays(days, testSet),
    missionBreakdown, levelBreakdown,
    topBadges: topBadgesAgg.map((row) => ({ badgeId: row._id, count: row.count })),
    eventBreakdown,
    definitions: {
      activeUsers: "students whose last activity in the app is in the range (Karachi days)",
      pushSent: "pushes delivered in the range (the push service confirmed them); failed, queued and sent-without-receipt are counted separately",
      rewardsRedeemed: "reward codes used at the brand in the range",
      codesIssued: "reward codes students took in the range",
      totalReferrals: "students who invited someone: at least one account signed up with their code (all time)",
      invitedSignups: "accounts created in the range with an invite code",
      examModeActive: "students in exam mode today (Karachi date)",
      weeklyUsers: "distinct users with any activity per week, Monday–Sunday in Karachi time",
    },
  };
}

module.exports = { engagementMetrics, weeksRange, isoWeekOf, weeklyFromDays };

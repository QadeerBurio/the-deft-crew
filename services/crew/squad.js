// services/crew/squad.js
// Plan P2-7 (owner): "bring your squad": invite 3 friends this week who join with your code AND verify their e-mail;
// a reward once per Karachi week (Monday 00:00), resets every week. Flag squadMission (per student, off).
// The reward: SQUAD_REWARD_POINTS points (default 100) through the points ledger, once per week (idempotent).
const TARGET = 3;
const rewardPoints = () => { const n = Number(process.env.SQUAD_REWARD_POINTS); return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.floor(n) : 100; };
const on = (userId) => require("../../config/featureFlags").isEnabled("squadMission", { id: String(userId), role: "student" });

/** { target, verified, weekKey, endsAt, rewarded, rewardPoints } (null with the flag off) */
async function progress(userId, now = new Date()) {
  if (!on(userId)) return null;
  const { verifiedReferrals, karachiWeekStart } = require("./ambassador");
  const { weekKey } = require("../../utils/karachiTime");
  const start = karachiWeekStart(now);
  const verified = await verifiedReferrals(userId, start);
  const key = `squad:${userId}:${weekKey(now)}`;
  const PointsLedger = require("../../models/PointsLedger");
  const rewarded = !!(await PointsLedger.exists({ $or: [{ idemKey: key }, { dedupeKey: key }] }));
  return { target: TARGET, verified, weekKey: weekKey(now), endsAt: new Date(start.getTime() + 7 * 24 * 3600e3), rewarded, rewardPoints: rewardPoints() };
}

/** Pay this week's reward when 3 verified friends joined (once). → { paid } */
async function evaluate(userId, now = new Date()) {
  try {
    const p = await progress(userId, now);
    if (!p || p.rewarded || p.verified < TARGET) return { paid: false };
    const r = await require("../engagement/points").award(String(userId), p.rewardPoints, "squad:weekly", { actorRole: "mission", refType: "squad", refId: p.weekKey, idemKey: `squad:${userId}:${p.weekKey}` });
    if (r?.duplicate) return { paid: false };
    await require("../engagement/popups").enqueue(String(userId), { kind: "squad_done", mood: "hype", line: `your squad is in: 3 friends this week. +${p.rewardPoints} pts.`, cta: { label: "view crew", route: "Points", params: {} }, payload: { week: p.weekKey, amount: p.rewardPoints }, priority: 25 }).catch(() => {});
    return { paid: true };
  } catch (e) {
    console.error("[squad] evaluate failed:", e.message);
    return { paid: false };
  }
}

module.exports = { progress, evaluate, TARGET, rewardPoints };

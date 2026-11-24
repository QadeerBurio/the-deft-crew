// services/confessionRecap.js
// P4c weekly campus recap (flags confessionsV2 + confessionRecap per student). Owner: numbers only (the confession push
// rule: never any confession text), and only a campus with at least 5 live confessions in the last 7 days:
//   "your campus this week" · "32 confessions this week. the top one got 41 likes. tap to read."
// (no "top one" sentence when the top one has no likes). Tapping opens that confession. Students with the confessions
// switch off are skipped; the push goes through the push budget as a broadcast (type confession_recap) and quiet hours.
// Run once a week by the engagement scheduler (Sunday 18:30 Karachi, JobLock per week).
//   run({ now, send }) → { campuses: [{ university, confessions, topLikes, students }], sent }
const MIN = 5;
const DAYS = 7;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function message(count, topLikes) {
  const head = `${plural(count, "confession", "confessions")} this week.`;
  return topLikes > 0 ? `${head} the top one got ${plural(topLikes, "like", "likes")}. tap to read.` : `${head} tap to read.`;
}

async function run({ now = new Date(), send } = {}) {
  const Confession = require("../models/Confession");
  const User = require("../models/User");
  const EngagementProfile = require("../models/EngagementProfile");
  const flags = require("../config/featureFlags");
  const push = send || require("../utils/pushNotification").sendToUser;
  const since = new Date(now.getTime() - DAYS * 864e5);
  const recent = await Confession.find({ createdAt: { $gte: since, $lte: now } }).select("university status likes createdAt").lean();
  const byUni = new Map();
  for (const c of recent) {
    if (c.status && c.status !== "live") continue; // held / hidden / removed don't count
    const key = String(c.university || "");
    if (!key) continue;
    const g = byUni.get(key) || { count: 0, top: null };
    g.count += 1;
    if (!g.top || (Number(c.likes) || 0) > (Number(g.top.likes) || 0) || ((Number(c.likes) || 0) === (Number(g.top.likes) || 0) && new Date(c.createdAt) > new Date(g.top.createdAt))) g.top = c;
    byUni.set(key, g);
  }
  const campuses = [];
  let sent = 0;
  for (const [university, g] of byUni) {
    if (g.count < MIN) continue;
    const students = (await User.find({ role: "student", university }).select("_id").lean())
      .map((u) => String(u._id))
      .filter((id) => flags.isEnabled("confessionsV2", { id, role: "student" }) && flags.isEnabled("confessionRecap", { id, role: "student" }));
    const off = new Set((await EngagementProfile.find({ user: { $in: students }, "notifPrefs.confessions": false }).select("user").lean()).map((p) => String(p.user)));
    const topLikes = Math.max(0, Number(g.top?.likes) || 0);
    const body = message(g.count, topLikes);
    let reached = 0;
    for (const id of students) {
      if (off.has(id)) continue;
      try {
        const r = await push(id, "your campus this week", body, {
          type: "confession_recap",
          route: "FeedScreen",
          params: { tab: "Confession", postId: String(g.top._id) },
          soundKey: "tdc_push_confession",
        });
        if (r?.sent !== false) { reached += 1; sent += 1; }
      } catch (e) {
        console.warn("[confession-recap] push failed:", e.message);
      }
    }
    campuses.push({ university, confessions: g.count, topLikes, students: reached });
  }
  console.log(`[confession-recap] ${campuses.length} campus(es), ${sent} push(es)`);
  return { campuses, sent };
}

module.exports = { run, message, MIN };

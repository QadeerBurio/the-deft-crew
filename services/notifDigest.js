// services/notifDigest.js
// Plan N-5 (flag notifSettingsV2): the daily campus digest, one push at 18:00 Karachi to students who turned
// "daily digest" on: "today at your campus: 12 confessions, 3 posts. 2 new events." Only real counts of today (a part
// that is 0 is left out; nothing at all → no push). With the digest on, the per-item campus pushes (new posts,
// confessions, listings) skip that student (services/pushBudget.js).
const mongoose = require("mongoose");
const { dayKey } = require("../utils/karachiTime");

const PKT_MS = 5 * 60 * 60 * 1000;
/** Start of today in Karachi, as a Date */
function startOfKarachiDay(now = new Date()) {
  const pkt = new Date(now.getTime() + PKT_MS);
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()) - PKT_MS);
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The digest line for counts { confessions, posts, events }, or null when there is nothing */
function line({ confessions = 0, posts = 0, events = 0 }) {
  const campus = [confessions ? plural(confessions, "confession", "confessions") : null, posts ? plural(posts, "post", "posts") : null].filter(Boolean);
  const parts = [];
  if (campus.length) parts.push(`today at your campus: ${campus.join(", ")}.`);
  if (events) parts.push(`${plural(events, "new event", "new events")}.`);
  return parts.length ? parts.join(" ") : null;
}

/** Today's counts per university id: Map uni → { confessions, posts }, and the number of new events (everyone) */
async function todayCounts(now = new Date()) {
  const since = startOfKarachiDay(now);
  const Confession = require("../models/Confession");
  const Post = require("../models/Post");
  const { Event } = require("../models/Event");
  const User = require("../models/User");
  const byUni = new Map();
  const bump = (uni, k) => { const key = String(uni); if (!byUni.has(key)) byUni.set(key, { confessions: 0, posts: 0 }); byUni.get(key)[k] += 1; };
  const live = { $or: [{ status: { $exists: false } }, { status: null }, { status: "live" }] };
  for (const c of await Confession.find({ createdAt: { $gte: since }, ...live }).select("university").lean()) if (c.university) bump(c.university, "confessions");
  const posts = await Post.find({ createdAt: { $gte: since } }).select("author").lean();
  const authors = [...new Set(posts.map((p) => String(p.author)).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const uniOf = new Map((await User.find({ _id: { $in: authors } }).select("university").lean()).map((u) => [String(u._id), u.university]));
  for (const p of posts) { const uni = uniOf.get(String(p.author)); if (uni) bump(uni, "posts"); }
  const events = await Event.countDocuments({ createdAt: { $gte: since }, status: "approved" });
  return { byUni, events };
}

/**
 * Send today's digest to every student with the digest on (and the flag). Once a day (the caller locks it).
 * gateway: services/engagement/pushGateway (tests pass their own). → { students, sent, skipped }
 */
async function sendDigests({ now = new Date(), gateway = null } = {}) {
  const flags = require("../config/featureFlags");
  if (!flags.pilotConfigured("notifSettingsV2")) return { students: 0, sent: 0, skipped: 0 };
  const EngagementProfile = require("../models/EngagementProfile");
  const User = require("../models/User");
  const g = gateway || require("./engagement/pushGateway");
  const profiles = await EngagementProfile.find({ "notifPrefs.digest": true }).select("user").limit(20000).lean();
  const users = await User.find({ _id: { $in: profiles.map((p) => p.user) }, role: "student" }).select("_id role university").lean();
  const { byUni, events } = await todayCounts(now);
  let sent = 0; let skipped = 0;
  for (const u of users) {
    if (!flags.isEnabled("notifSettingsV2", { id: String(u._id), role: u.role })) { skipped++; continue; }
    const text = line({ ...(byUni.get(String(u.university)) || {}), events });
    if (!text) { skipped++; continue; }
    try {
      const r = await g.send(u._id, { type: "campus_digest", budgetClass: "personal", essential: true, title: "your campus today", body: text, data: { route: "FeedScreen", params: {}, digestDay: dayKey(now) } });
      if (r?.sent) sent++; else skipped++;
    } catch (e) {
      skipped++;
      console.error(`[digest] push failed: ${e.message}`);
    }
  }
  console.log(`[digest] ${dayKey(now)}: ${users.length} students with the digest on, ${sent} sent, ${skipped} skipped`);
  return { students: users.length, sent, skipped };
}

module.exports = { line, todayCounts, sendDigests, startOfKarachiDay };

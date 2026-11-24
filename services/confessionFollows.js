// services/confessionFollows.js
// P4b (flag confessionFollow): follow a confession (the bell) → a push on new replies. Owner decisions: the author
// follows their own confession automatically, never named, and can mute it in one tap (on: false).
// The reply push: never the reply's text, the commenter or the confession's text (the confession push rule), only
// "new reply on a confession you follow"; not to the one who replied; only to followers with the flag on and the
// confessions switch not off; at most one per confession per 30 minutes for each follower; through the push budget
// (type confession_follow = "relevant") and quiet hours; the confession sound.
//   setFollow(userId, confessionId, on, { author })   → { following }
//   followingSet(userId, confessionIds)               → Set of followed ids (on)
//   notifyReply({ confessionId, commenterId })        → { sent }   (call only for a live reply)
const ConfessionFollow = require("../models/ConfessionFollow");

const THROTTLE = 30 * 60 * 1000;
const flagOn = (userId) => require("../config/featureFlags").isEnabled("confessionFollow", { id: String(userId), role: "student" });

async function setFollow(userId, confessionId, on, { author = false } = {}) {
  await ConfessionFollow.updateOne(
    { user: userId, confession: confessionId },
    { $set: { on: !!on }, $setOnInsert: { user: userId, confession: confessionId, author: !!author, createdAt: new Date() } },
    { upsert: true },
  );
  return { following: !!on };
}

async function followingSet(userId, confessionIds) {
  if (!userId || !confessionIds?.length) return new Set();
  const rows = await ConfessionFollow.find({ user: userId, confession: { $in: confessionIds }, on: true }).select("confession").lean();
  return new Set(rows.map((r) => String(r.confession)));
}

async function notifyReply({ confessionId, commenterId, send }) {
  const followers = await ConfessionFollow.find({ confession: confessionId, on: true }).select("user lastPushAt").lean();
  const now = Date.now();
  const due = followers.filter((f) => String(f.user) !== String(commenterId) && (!f.lastPushAt || now - new Date(f.lastPushAt).getTime() >= THROTTLE) && flagOn(f.user));
  if (!due.length) return { sent: 0 };
  const EngagementProfile = require("../models/EngagementProfile");
  const off = new Set((await EngagementProfile.find({ user: { $in: due.map((f) => f.user) }, "notifPrefs.confessions": false }).select("user").lean()).map((p) => String(p.user)));
  const push = send || require("../utils/pushNotification").sendToUser;
  let sent = 0;
  for (const f of due) {
    if (off.has(String(f.user))) continue;
    // claimed before sending, so two replies at once give one push
    const claimed = await ConfessionFollow.updateOne(
      { _id: f._id, $or: [{ lastPushAt: null }, { lastPushAt: { $lte: new Date(now - THROTTLE) } }] },
      { $set: { lastPushAt: new Date(now) } },
    );
    if (!(claimed.modifiedCount || claimed.nModified)) continue;
    try {
      const r = await push(f.user, "new reply on a confession you follow", "", {
        type: "confession_follow",
        route: "FeedScreen",
        params: { tab: "Confession", postId: String(confessionId) },
        soundKey: "tdc_push_confession",
      });
      if (r?.sent !== false) sent += 1;
    } catch (e) {
      console.warn("[confession-follow] push failed:", e.message);
    }
  }
  return { sent };
}

module.exports = { setFollow, followingSet, notifyReply, THROTTLE };

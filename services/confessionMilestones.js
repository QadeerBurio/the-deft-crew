// services/confessionMilestones.js — P5b (flag celebrationsPlus, off by default): when a confession first reaches
// 10 likes, its author gets an in-app celebration ("10 people liked your confession."): no names, no confession text,
// no push. Once per confession (likes10CelebratedAt, set atomically, so a like burst can't celebrate twice), and only
// when the author has the flag at that moment (without it, nothing is marked: a later 10th like can still count).
const Confession = require("../models/Confession");
const flags = require("../config/featureFlags");
const popups = require("./engagement/popups");

const LIKES = 10;

async function maybeCelebrateTenLikes(confessionId) {
  const c = await Confession.findById(confessionId).select("+authorId +likes10CelebratedAt likes").lean();
  if (!c || !c.authorId || (c.likes || 0) < LIKES || c.likes10CelebratedAt) return false;
  const authorId = String(c.authorId);
  if (!flags.isEnabled("celebrationsPlus", { id: authorId, role: "student" })) return false;
  const r = await Confession.updateOne({ _id: c._id, likes10CelebratedAt: { $exists: false } }, { $set: { likes10CelebratedAt: new Date() } });
  if (!r || !(r.modifiedCount || r.nModified)) return false; // another request celebrated it first
  await popups.enqueue(authorId, {
    kind: "confession_likes",
    mood: "excited",
    line: "10 people liked your confession.",
    cta: { label: "see it", route: "FeedScreen", params: { tab: "Confession", postId: String(c._id) } },
    meta: { confessionId: String(c._id), likes: LIKES },
    priority: 1,
  });
  return true;
}

module.exports = { maybeCelebrateTenLikes, LIKES };

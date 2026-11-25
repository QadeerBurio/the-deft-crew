// services/confessionVotes.js
// r7, plan P4-3: "Upvote/downvote: optional, behind a sub-flag (confessionsVoting). Recommended off at launch, used only
// for auto-hide." A vote is up, down or none (one per student per confession; changing it moves it). Nobody sees the
// counts. A confession hides (status "hidden", reason "hidden by down votes", into the Safety "held" queue) once it has at least
// HIDE_MIN_DOWN down votes and at least HIDE_RATIO times as many down as up. An admin's "approve" is final: a confession
// approved by an admin is never hidden by votes again. The author can't vote on their own confession.
const mongoose = require("mongoose");
const Confession = require("../models/Confession");

const HIDE_MIN_DOWN = 10;
const HIDE_RATIO = 2;
const REASON = "hidden by down votes"; // shown as-is in the admin Safety "held" queue
const APPROVED = "approved by admin"; // routes/adminSafety.routes.js, held → approve

const shouldHide = (up, down) => down >= HIDE_MIN_DOWN && down >= HIDE_RATIO * up;

/** the student's vote on each of these confessions → Map(id → "up" | "down") (two small id-only queries) */
async function myVotes(userId, ids) {
  const out = new Map();
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId)) || !ids?.length) return out;
  const me = new mongoose.Types.ObjectId(String(userId));
  for (const [field, dir] of [["voteUp", "up"], ["voteDown", "down"]]) {
    const rows = await Confession.find({ _id: { $in: ids }, [field]: me }).select("_id").lean();
    for (const r of rows) out.set(String(r._id), dir);
  }
  return out;
}

/**
 * set the student's vote: dir "up" | "down" | null (none). c: the confession with +authorId status statusReason.
 * → { vote, hidden } (hidden: this vote hid it)
 */
async function vote(c, userId, dir) {
  const me = new mongoose.Types.ObjectId(String(userId));
  await Confession.updateOne({ _id: c._id }, { $pull: { voteUp: me, voteDown: me } });
  if (dir === "up" || dir === "down") await Confession.updateOne({ _id: c._id }, { $addToSet: { [dir === "up" ? "voteUp" : "voteDown"]: me } });
  const after = await Confession.findById(c._id).select("+voteUp +voteDown status statusReason").lean();
  const up = (after?.voteUp || []).length;
  const down = (after?.voteDown || []).length;
  const set = { voteUpCount: up, voteDownCount: down };
  const hide = !!after && Confession.isLive(after) && after.statusReason !== APPROVED && shouldHide(up, down);
  if (hide) Object.assign(set, { status: "hidden", statusReason: REASON, statusAt: new Date() });
  await Confession.updateOne({ _id: c._id }, { $set: set });
  return { vote: dir === "up" || dir === "down" ? dir : null, hidden: hide };
}

module.exports = { vote, myVotes, shouldHide, HIDE_MIN_DOWN, HIDE_RATIO, REASON };

// routes/confessionsV2.routes.js
// P4a confessions v2 (flag confessionsV2; signed-in students; off: 404, as if absent), mounted at /api/social before
// routes/social.routes.js (new paths only):
//   GET /confessions/v2/config   → { tags: [{ id, label }], prompts: [3 this week], moods: [...], maxLength: 500,
//                                   handle: { enabled, handle } }   handle: the student's own (made on first use), only
//                                   once the owner approved the word lists (config/confessionHandles.js)
//   PUT /confessions/:id/metoo   → { meToo, meTooCount }   toggles "me too" (who tapped is never sent)
//   P4b: PUT /confessions/:id/poll { option } (+ confessionPolls) → { poll }; PUT /confessions/:id/follow { on }
//   (+ confessionFollow) → { following }; PUT /confessions/:id/save { on } → { saved } (the list: feed ?saved=1)
//   r7: PUT /confessions/:id/vote { vote: up | down | null } (+ confessionsVoting) → { vote }; used only for auto-hide
// The feed and create changes (sort, tag filter, tag / mood / post as handle) are in social.routes.js, behind the same flag.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const Confession = require("../models/Confession");
const flags = require("../config/featureFlags");
const settings = require("../services/safetySettings");
const handles = require("../services/confessionHandles");
const { MOODS } = require("../config/confessionMoods");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const guest = (req) => !!req.isGuest || req.userId === "guest-user";
const meOf = (req) => String(req.user?._id || req.userId || "");
const notFound = (res) => res.status(404).json({ error: "Not found", message: "Not found" });
const gate = (req, res, next) => {
  if (guest(req) || !flags.isEnabled("confessionsV2", { id: meOf(req), role: req.userRole })) return notFound(res);
  next();
};
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error("[confessions-v2]", e.message);
    res.status(500).json({ error: "something went wrong. try again.", message: "something went wrong. try again." });
  }
};
// a confession this student may see (live, and campus-only ones only for that campus)
const canSee = (req, c) => {
  if (!c || !Confession.isLive(c)) return false;
  if (c.visibility !== "campus") return true;
  const mine = String(req.user?.university?._id || req.user?.university || "");
  return !!mine && mine === String(c.university?._id || c.university || "");
};

router.get("/confessions/v2/config", auth, gate, wrap(async (req, res) => {
  const s = await settings.get();
  const handle = handles.enabled(meOf(req)) ? await handles.ensureHandle(meOf(req)) : null;
  res.json({
    tags: s.tags.filter((t) => !t.hidden).map((t) => ({ id: t.id, label: t.label })),
    prompts: settings.promptsThisWeek(s),
    moods: MOODS,
    maxLength: 500,
    handle: { enabled: !!handle, handle: handle || null },
  });
}));

router.put("/confessions/:id/metoo", auth, gate, wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const c = await Confession.findById(req.params.id).select("+meTooBy status visibility university meTooCount").lean();
  if (!canSee(req, c)) return notFound(res);
  const me = meOf(req);
  const had = (c.meTooBy || []).some((x) => String(x) === me);
  const update = had
    ? { $pull: { meTooBy: new mongoose.Types.ObjectId(me) }, $inc: { meTooCount: -1 } }
    : { $addToSet: { meTooBy: new mongoose.Types.ObjectId(me) }, $inc: { meTooCount: 1 } };
  await Confession.updateOne({ _id: c._id }, update);
  const after = await Confession.findById(c._id).select("meTooCount").lean();
  res.json({ meToo: !had, meTooCount: Math.max(0, Number(after?.meTooCount) || 0) });
}));

// ---------- P4b ----------
const subFlag = (name) => (req, res, next) => (flags.isEnabled(name, { id: meOf(req), role: req.userRole }) ? next() : notFound(res));
const polls = require("../services/confessionPolls");
const follows = require("../services/confessionFollows");

// a vote (or a changed vote) in a confession's poll → the poll as the student sees it (never who voted)
router.put("/confessions/:id/poll", auth, gate, subFlag("confessionPolls"), wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const c = await Confession.findById(req.params.id).select("+pollVoters status visibility university poll").lean();
  if (!canSee(req, c) || !c.poll?.options?.length) return notFound(res);
  const option = Number(req.body?.option);
  if (!Number.isInteger(option) || option < 0 || option >= c.poll.options.length) return res.status(400).json({ code: "BAD_OPTION", error: "pick one of the options.", message: "pick one of the options." });
  const me = meOf(req);
  const next = polls.applyVote(c.poll, c.pollVoters, new mongoose.Types.ObjectId(me), option);
  if (next.changed) await Confession.updateOne({ _id: c._id }, { $set: { poll: next.poll, pollVoters: next.voters } });
  res.json({ poll: polls.view(next.poll, next.voters, me) });
}));

// follow / unfollow (the author: mute / unmute their own) → { following }
router.put("/confessions/:id/follow", auth, gate, subFlag("confessionFollow"), wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const c = await Confession.findById(req.params.id).select("status visibility university").lean();
  if (!canSee(req, c)) return notFound(res);
  res.json(await follows.setFollow(meOf(req), c._id, req.body?.on !== false));
}));

// save / unsave (SavedItem kind "confession") → { saved }; the saved list is the feed with ?saved=1
router.put("/confessions/:id/save", auth, gate, wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const SavedItem = require("../models/SavedItem");
  const on = req.body?.on !== false;
  if (!on) {
    await SavedItem.deleteOne({ user: meOf(req), kind: "confession", refId: req.params.id });
    return res.json({ saved: false });
  }
  const c = await Confession.findById(req.params.id).select("status visibility university").lean();
  if (!canSee(req, c)) return notFound(res);
  try { await SavedItem.create({ user: meOf(req), kind: "confession", refId: c._id }); } catch (e) { if (e?.code !== 11000) throw e; }
  res.json({ saved: true });
}));

// ---------- P4c: share as an image card + its gettdc.pk/c/<id> page ----------
// the server decides (owner rules: public, live, no open report); the card never carries a handle
router.post("/confessions/:id/share", auth, gate, subFlag("confessionShare"), wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const share = require("../services/confessionShare");
  const c = await Confession.findById(req.params.id).select("text status visibility university").lean();
  if (!canSee(req, c)) return notFound(res);
  const no = share.refusal(c, { openReport: (await share.openReports([c._id])).size > 0 });
  if (no) return res.status(no.status).json({ code: no.code, error: no.message, message: no.message });
  await Confession.updateOne({ _id: c._id, sharedAt: { $exists: false } }, { $set: { sharedAt: new Date() } }); // the first share
  await Confession.updateOne({ _id: c._id }, { $set: { sharedBy: new mongoose.Types.ObjectId(meOf(req)) }, $inc: { shareCount: 1 } });
  res.json({ url: share.pageUrl(String(c._id)), text: String(c.text || "") });
}));

// ---------- r7: voting (confessionsVoting), used only for auto-hide ----------
// PUT /confessions/:id/vote { vote: "up" | "down" | null } → { vote }. No counts, ever. Not on your own confession.
router.put("/confessions/:id/vote", auth, gate, subFlag("confessionsVoting"), wrap(async (req, res) => {
  if (!isId(req.params.id)) return notFound(res);
  const dir = req.body?.vote;
  if (!(dir === "up" || dir === "down" || dir === null)) return res.status(400).json({ error: "vote: up | down | null", message: "vote: up | down | null" });
  const c = await Confession.findById(req.params.id).select("+authorId status statusReason visibility university").lean();
  if (!canSee(req, c)) return notFound(res);
  if (String(c.authorId || "") === meOf(req)) return res.status(400).json({ code: "OWN_CONFESSION", error: "you can't vote on your own confession.", message: "you can't vote on your own confession." });
  const r = await require("../services/confessionVotes").vote(c, meOf(req), dir);
  res.json({ vote: r.vote });
}));

module.exports = router;

// routes/confessionsV2.routes.js
// P4a confessions v2 (flag confessionsV2; signed-in students; off: 404, as if absent), mounted at /api/social before
// routes/social.routes.js (new paths only):
//   GET /confessions/v2/config   → { tags: [{ id, label }], prompts: [3 this week], moods: [...], maxLength: 500,
//                                   handle: { enabled, handle } }   handle: the student's own (made on first use), only
//                                   once the owner approved the word lists (config/confessionHandles.js)
//   PUT /confessions/:id/metoo   → { meToo, meTooCount }   toggles "me too" (who tapped is never sent)
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
  const handle = handles.enabled() ? await handles.ensureHandle(meOf(req)) : null;
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

module.exports = router;

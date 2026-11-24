// routes/resumeCoach.routes.js
// Plan P3-4b, mounted at /api/resume/ai (flags resumeV2 + resumeCoach per student; off: 404, as if absent):
//   POST /coach       { action, facts }        → { suggestions, usedFacts, questions, ... }  (services/resumeCoach.js)
//   POST /check       { field, text, current } → { issues }       live checks for one field (spelling cached by text)
//   POST /autofix     { resumeId }             → { changes, patch } "fix everything", previewed; the app saves the patch
//   POST /transcribe  multipart "audio" (≤ 60 s, ≤ 2 MB)  → { text }  speak mode (also needs resumeSpeak); never stored
// All share the per-user limit resume_ai with the builder's other AI helpers. English only.
const express = require("express");
const multer = require("multer");
const auth = require("../middleware/auth.middleware");
const { perUser } = require("../utils/userRateLimit");
const { isEnabled } = require("../config/featureFlags");
const coach = require("../services/resumeCoach");

const router = express.Router();
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message, error: message });
const on = (name, req) => isEnabled(name, { id: String(req.userId), role: req.userRole || "student" });
const gate = (...names) => (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(res, 401, "SIGN_IN", "sign in first");
  return names.every((n) => on(n, req)) ? next() : fail(res, 404, "NOT_FOUND", "not found");
};
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof coach.CoachError) return fail(res, e.status, e.code, e.message);
    console.error("[resume-coach]", e.message);
    return fail(res, 502, "AI_UNAVAILABLE", "the coach couldn't help right now. try again in a moment.");
  }
};
const limit = perUser("resume_ai");
const COACH = [auth, gate("resumeV2", "resumeCoach")];

router.post("/coach", ...COACH, limit, handle(async (req, res) => res.json({ success: true, data: await coach.coach(req.body || {}) })));
router.post("/check", ...COACH, limit, handle(async (req, res) => {
  const { field, text, current } = req.body || {};
  if (!["bullet", "summary", "title", "email", "phone", "linkedin"].includes(field)) return fail(res, 400, "BAD_FIELD", "field: bullet | summary | title | email | phone | linkedin");
  res.json({ success: true, data: await coach.check({ field, text, current: !!current }) });
}));
router.post("/autofix", ...COACH, limit, handle(async (req, res) => {
  const id = req.body?.resumeId;
  if (!isId(id)) return fail(res, 400, "BAD_ID", "resumeId required");
  const resume = await require("../models/Resume").findOne({ _id: id, user: req.userId }).lean();
  if (!resume) return fail(res, 404, "NOT_FOUND", "resume not found");
  res.json({ success: true, data: coach.autofix(resume) });
}));

const audio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single("audio");
router.post("/transcribe", auth, gate("resumeV2", "resumeSpeak"), limit, (req, res, next) => audio(req, res, (err) => (err ? fail(res, 413, "TOO_LONG", "keep it under a minute.") : next())), handle(async (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (Number.isFinite(seconds) && seconds > 60) return fail(res, 413, "TOO_LONG", "keep it under a minute.");
  const out = await coach.transcribe(req.file?.buffer, req.file?.mimetype || "audio/m4a");
  res.json({ success: true, data: out }); // the audio was only in memory; nothing is kept
}));

module.exports = router;

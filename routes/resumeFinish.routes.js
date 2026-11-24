// routes/resumeFinish.routes.js
// P3d, mounted at /api/resume before routes/resume.routes.js (new paths only; nothing there changes). Each feature needs
// resumeV2 + its own flag for the signed-in student; off: 404, as if absent.
//   POST /:id/feedback   → feedback (services/resumeFeedback.js)            flag resumeFeedback, shared limit resume_ai
const express = require("express");
const auth = require("../middleware/auth.middleware");
const { perUser } = require("../utils/userRateLimit");
const { isEnabled } = require("../config/featureFlags");

const router = express.Router();
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message, error: message });
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const on = (name, req) => isEnabled(name, { id: String(req.userId), role: req.userRole || "student" });
const gate = (...names) => (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(res, 401, "SIGN_IN", "sign in first");
  return names.every((n) => on(n, req)) ? next() : fail(res, 404, "NOT_FOUND", "not found");
};
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    console.error("[resume-finish]", e.message);
    return fail(res, 500, "SERVER_ERROR", "something went wrong. try again in a moment.");
  }
};
const ownResume = async (req, select) => {
  if (!isId(req.params.id)) return null;
  const q = require("../models/Resume").findOne({ _id: req.params.id, user: req.userId });
  if (select) q.select(select);
  return q.lean();
};

// ---------- P3-7 feedback ----------
router.post("/:id/feedback", auth, gate("resumeV2", "resumeFeedback"), perUser("resume_ai"), handle(async (req, res) => {
  const resume = await ownResume(req);
  if (!resume) return fail(res, 404, "NOT_FOUND", "resume not found");
  ok(res, await require("../services/resumeFeedback").feedback(resume, { userId: req.userId }));
}));

module.exports = router;

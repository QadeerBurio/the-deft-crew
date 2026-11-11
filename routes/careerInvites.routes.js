// routes/careerInvites.routes.js — /api/career/invites: a student's invites to apply (services/career/invites.js),
// FLAG_CAREER_MATCHING. The opt-in to be suggested at all is ProfessionalProfile.discoverable (off by default), set
// with the existing POST /api/professional-profile { discoverable }.
//   GET  /me              { discoverable, invites: [{ id, job: { id, title, companyName, location, type }, status, sentAt }] }
//   POST /:id/respond     { response: "interested" | "declined" }
// Replies: { success: true, data, requestId } or { success: false, error: { code, message }, requestId }.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const invites = require("../services/career/invites");

const router = express.Router();
const ok = (req, res, data) => res.json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });
const student = async (req, res, next) => {
  if (req.isGuest || !mongoose.Types.ObjectId.isValid(String(req.userId || ""))) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  if (u.role !== "student") return fail(req, res, 404, "NOT_FOUND", "Invites are for students");
  next();
};
const handle = (fn) => async (req, res) => {
  try { ok(req, res, await fn(req)); } catch (err) {
    if (err instanceof invites.InviteError) return fail(req, res, err.status, err.code, err.message);
    console.error("[career-invites]", err.message);
    fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

router.get("/me", auth, student, handle((req) => invites.myInvites(req.userId)));
router.post("/:id/respond", auth, student, handle((req) => invites.respond(req.userId, req.params.id, req.body?.response)));

module.exports = router;

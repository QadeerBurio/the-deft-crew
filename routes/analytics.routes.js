// routes/analytics.routes.js — /api/analytics (services/analytics/businessAnalytics.js). Read-only figures from
// authoritative records, for admins, brands and employers only (students get nothing new; no flag needed).
//   GET /admin/overview?from&to    admin: discounts, loyalty, Surprise Box, hiring, employers
//   GET /brands/me?from&to         brand: its own redemptions, repeat customers, loyalty, Surprise Box
//   GET /employers/me?from&to      employer: its own hiring funnel (+ First Hire Free summary when piloted)
// Replies: { success: true, data, requestId } or { success: false, error: { code, message }, requestId }.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const analytics = require("../services/analytics/businessAnalytics");

const router = express.Router();
const ok = (req, res, data) => res.json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status && err.code) return fail(req, res, err.status, err.code, err.message);
    console.error("[analytics]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
const role = (r) => async (req, res, next) => {
  if (req.isGuest || !mongoose.Types.ObjectId.isValid(String(req.userId || ""))) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u || u.role !== r) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  next();
};

router.get("/admin/overview", auth, role("admin"), handle(async (req, res) => ok(req, res, await analytics.adminOverview(req.query))));
router.get("/brands/me", auth, role("brand"), handle(async (req, res) => ok(req, res, await analytics.brandInsights(req.userId, req.query))));
router.get("/employers/me", auth, role("employee"), handle(async (req, res) => {
  ok(req, res, await analytics.employerResults(req.userId, req.query, { trialService: require("../services/career/trialService") }));
}));

module.exports = router;

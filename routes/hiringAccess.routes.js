// routes/hiringAccess.routes.js — free trial and hiring plans under /api/career (services/career/hiringAccessService.js).
// For every employer (no feature flag). Mounted before routes/careerTrial.routes.js; other requests pass through.
// Replies: { success: true, data, requestId } or { success: false, error: { code, message, ... }, requestId }.
//
// Employer:
//   GET  /employers/me/hiring-access          trial (days left, free hire used, end reason) or plan (jobs left,
//                                             valid until), canPost, the lock message, an open plan request
//   POST /employers/me/plan-requests          { jobs (1-100), note }: "request a plan"; admins are notified
// Admin (every change needs a reason and is written to AdminActionLog):
//   GET  /admin/hiring-plans                  every employer's trial / plan, the requests, counts
//   POST /admin/hiring-plans/:employerId/grant   { jobs?, validUntil?, reason, requestId? }
//   POST /admin/hiring-plans/:employerId/trial   { action: extend (until) | end, reason }
//   POST /admin/plan-requests/:id/decline        { reason }
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const access = require("../services/career/hiringAccessService");
const { CareerError } = require("../services/career/careerTimelineService");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof CareerError) return fail(req, res, err.status, err.code, err.message, err.extra);
    console.error("[hiring access]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
const role = (r) => async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  if (u.role !== r) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  next();
};
const employer = [auth, role("employee")];
const admin = [auth, role("admin")];

router.get("/employers/me/hiring-access", ...employer, handle(async (req, res) => ok(req, res, await access.viewFor(req.userId))));

router.post("/employers/me/plan-requests", ...employer, handle(async (req, res) => {
  const { created } = await access.requestPlan(req.userId, req.body || {});
  ok(req, res, await access.viewFor(req.userId), created ? 201 : 200);
}));

router.get("/admin/hiring-plans", ...admin, handle(async (req, res) => ok(req, res, await access.adminOverview())));

router.post("/admin/hiring-plans/:employerId/grant", ...admin, handle(async (req, res) => {
  await access.grantPlan(req.userId, req.params.employerId, req.body || {}, { requestId: req.id });
  ok(req, res, await access.viewFor(req.params.employerId));
}));

router.post("/admin/hiring-plans/:employerId/trial", ...admin, handle(async (req, res) => {
  const action = String(req.body?.action || "");
  if (action === "extend") await access.extendTrial(req.userId, req.params.employerId, req.body || {}, { requestId: req.id });
  else if (action === "end") await access.endTrial(req.userId, req.params.employerId, req.body || {}, { requestId: req.id });
  else return fail(req, res, 400, "INVALID_ACTION", "action must be extend or end");
  ok(req, res, await access.viewFor(req.params.employerId));
}));

router.post("/admin/plan-requests/:id/decline", ...admin, handle(async (req, res) => {
  const r = await access.declineRequest(req.userId, req.params.id, req.body || {}, { requestId: req.id });
  ok(req, res, { id: String(r._id), status: r.status });
}));

module.exports = router;

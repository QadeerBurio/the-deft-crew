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

// ---------- company verification (every employer; jobs posted before it wait) ----------
const trialService = require("../services/career/trialService");
const EmployerCompanyVerification = require("../models/EmployerCompanyVerification");
const Job = require("../models/Job");
const AdminLog = require("../services/adminActionLog");
const pendingJobsOf = async (employerIds) => {
  const jobs = await Job.find({ postedBy: { $in: employerIds }, pendingVerification: true, archivedAt: null }).select("postedBy title createdAt").sort({ createdAt: 1 }).lean();
  const by = new Map();
  for (const j of jobs) {
    const k = String(j.postedBy);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ id: String(j._id), title: j.title, postedAt: j.createdAt });
  }
  return by;
};
async function myVerification(employerId) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean();
  const pending = (await pendingJobsOf([employerId])).get(String(employerId)) || [];
  return {
    verified: v?.status === "approved",
    verification: v ? { id: String(v._id), status: v.status, companyName: v.companyName, registrationType: v.registrationType, ntnOrSecp: v.ntnOrSecp, businessEmailDomain: v.businessEmailDomain, website: v.website, reason: v.reason || "", reviewedAt: v.reviewedAt, submittedAt: v.createdAt } : null,
    pendingJobs: pending,
    message: v?.status === "approved" ? null : "Your jobs go live once your company is verified by tdc.",
  };
}
//   GET  /employers/me/company-verification   { verified, verification, pendingJobs, message }
//   POST /employers/me/company-verification   { companyName, registrationType, ntnOrSecp, businessEmailDomain, website }
router.get("/employers/me/company-verification", ...employer, handle(async (req, res) => ok(req, res, await myVerification(req.userId))));
router.post("/employers/me/company-verification", ...employer, handle(async (req, res) => {
  const { created } = await trialService.submitVerification(req.userId, req.body || {});
  ok(req, res, await myVerification(req.userId), created ? 201 : 200);
}));
//   GET  /admin/company-verifications?status   each with the employer's jobs waiting for it
//   POST /admin/company-verifications/:id/review  { action: approve|reject|mark_duplicate, reason, separateGroup? };
//                                              approve publishes the waiting jobs
router.get("/admin/company-verifications", ...admin, handle(async (req, res) => {
  const st = String(req.query.status || "pending");
  const list = await EmployerCompanyVerification.find(st === "all" ? {} : { status: st }).sort({ createdAt: -1 }).limit(300).lean();
  const trialRoutes = require("./careerTrial.routes");
  const users = await trialRoutes.usersById(list.flatMap((v) => [v.employerUserId, ...(v.duplicateOf || []).map((d) => d.employerUserId)]));
  const pending = await pendingJobsOf(list.map((v) => v.employerUserId));
  ok(req, res, list.map((v) => ({ ...trialRoutes.verificationView(v, users), pendingJobs: pending.get(String(v.employerUserId)) || [] })));
}));
router.post("/admin/company-verifications/:id/review", ...admin, handle(async (req, res) => {
  const { action, reason, separateGroup } = req.body || {};
  const v = await trialService.reviewVerification(req.userId, req.params.id, { action, reason, separateGroup: separateGroup === true });
  await AdminLog.recordSafe({ adminId: req.userId, action: "employer.verification.review", targetType: "EmployerCompanyVerification", targetId: String(req.params.id), before: null, after: { action: String(action || ""), status: v.status, publishedJobs: v.publishedJobs || 0 }, reason, requestId: req.id });
  ok(req, res, { id: String(v._id), status: v.status, publishedJobs: v.publishedJobs || 0 });
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

// routes/careerTrial.routes.js — First Hire Free under /api/career (services/career/trialService.js). Behind
// FLAG_EMPLOYER_FIRST_HIRE_FREE: off for the employer = 404 and nothing is written. Admin pages work once the
// flag is set for anyone. Mounted before routes/career.routes.js; requests it doesn't own pass through.
// Replies: { success: true, data, requestId } or { success: false, error: { code, message, ... }, requestId }.
//
// Employer (own company only; the registration number appears only in their own and admin replies):
//   GET  /employers/me/trial               status, remaining free hires, policy, next action, own company details
//   POST /employers/me/verification        { companyName, registrationType: ntn|secp, ntnOrSecp, businessEmailDomain, website }
//   POST /employers/me/trial/activate      after approval; idempotent; one trial per company group
//   GET  /employers/me/trial/summary       real counts: applicants, completed interviews, verified hires, free hire used
// Admin (every decision needs a reason and is written to CareerAdminAudit):
//   GET  /admin/verifications              ?status=pending|duplicate_review|approved|rejected|all
//   POST /admin/verifications/:id/review   { action: approve|reject|mark_duplicate, reason, separateGroup? }
//   GET  /admin/trials                     ?status=active|used|under_review|all, with suspected duplicates
//   POST /admin/trials/:id/review          { action: restore|revoke|keep, reason }
//   GET  /admin/billing-events             ?companyGroupKey&eventType (read-only ledger)
//   GET  /admin/employers/company-status   which employer accounts have a verified company (admin employer list)
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const JobApplication = require("../models/JobApplication");
const Job = require("../models/Job");
const EmployerCompanyVerification = require("../models/EmployerCompanyVerification");
const EmployerHiringTrial = require("../models/EmployerHiringTrial");
const EmployerHiringBillingEvent = require("../models/EmployerHiringBillingEvent");
const CareerAdminAudit = require("../models/CareerAdminAudit");
const trial = require("../services/career/trialService");
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
    console.error("[career trial]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
const gate = (role) => async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const on = role === "admin" ? trial.pilotConfigured() : trial.flagOn(req.userId);
  if (!on) return fail(req, res, 404, "FIRST_HIRE_FREE_OFF", "First Hire Free isn't available for your account yet");
  if (u.role !== role) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  next();
};
const employer = [auth, gate("employee")];
const admin = [auth, gate("admin")];

// ---------- employer ----------
router.get("/employers/me/trial", ...employer, handle(async (req, res) => ok(req, res, await trial.viewFor(req.userId))));

router.post("/employers/me/verification", ...employer, handle(async (req, res) => {
  const { created } = await trial.submitVerification(req.userId, req.body || {});
  ok(req, res, await trial.viewFor(req.userId), created ? 201 : 200);
}));

router.post("/employers/me/trial/activate", ...employer, handle(async (req, res) => {
  const { created } = await trial.activate(req.userId);
  ok(req, res, await trial.viewFor(req.userId), created ? 201 : 200);
}));

router.get("/employers/me/trial/summary", ...employer, handle(async (req, res) => ok(req, res, await trial.summaryFor(req.userId))));

// ---------- admin ----------
const usersById = async (ids) => new Map((await User.find({ _id: { $in: [...new Set(ids.filter(Boolean).map(String))] } }).select("name email companyName status").lean()).map((u) => [String(u._id), u]));
const verificationView = (v, users) => {
  const u = users.get(String(v.employerUserId));
  return {
    id: String(v._id), employer: { id: String(v.employerUserId), name: u?.name || "", email: u?.email || "", accountStatus: u?.status || "" },
    companyName: v.companyName, registrationType: v.registrationType, ntnOrSecp: v.ntnOrSecp, businessEmailDomain: v.businessEmailDomain, website: v.website,
    companyGroupKey: v.companyGroupKey, status: v.status, reason: v.reason, reviewedAt: v.reviewedAt, submittedAt: v.createdAt,
    hints: { signInEmailMatchesDomain: v.signInEmailMatchesDomain, websiteMatchesDomain: v.websiteMatchesDomain },
    duplicateOf: (v.duplicateOf || []).map((d) => ({ verificationId: String(d.verificationId), employer: { id: String(d.employerUserId), name: users.get(String(d.employerUserId))?.name || "" }, matchedOn: d.matchedOn })),
    history: v.history,
  };
};

router.get("/admin/verifications", ...admin, handle(async (req, res) => {
  const s = String(req.query.status || "pending");
  const filter = s === "all" ? {} : { status: s };
  const list = await EmployerCompanyVerification.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  const users = await usersById(list.flatMap((v) => [v.employerUserId, ...(v.duplicateOf || []).map((d) => d.employerUserId)]));
  ok(req, res, list.map((v) => verificationView(v, users)));
}));

router.post("/admin/verifications/:id/review", ...admin, handle(async (req, res) => {
  const { action, reason, separateGroup } = req.body || {};
  const v = await trial.reviewVerification(req.userId, req.params.id, { action, reason, separateGroup: separateGroup === true });
  await require("../services/adminActionLog").recordSafe({ adminId: req.userId, action: "fhf.verification.review", targetType: "EmployerCompanyVerification", targetId: String(req.params.id), before: null, after: { action: String(action || ""), status: v.status, separateGroup: separateGroup === true }, reason, requestId: req.id });
  ok(req, res, verificationView(v, await usersById([v.employerUserId, ...(v.duplicateOf || []).map((d) => d.employerUserId)])));
}));

router.get("/admin/trials", ...admin, handle(async (req, res) => {
  await trial.reconcile().catch((e) => console.error(`[trial] reconcile failed: ${e.message}`));
  const s = String(req.query.status || "all");
  const list = await EmployerHiringTrial.find(s === "all" ? {} : { eligibilityStatus: s }).sort({ createdAt: -1 }).limit(300).lean();
  const verifs = await EmployerCompanyVerification.find({ companyGroupKey: { $in: list.map((t) => t.companyGroupKey) } }).lean();
  const apps = await JobApplication.find({ _id: { $in: list.map((t) => t.consumedByApplicationId).filter(Boolean) } }).select("jobId userId").lean();
  const jobs = new Map((await Job.find({ _id: { $in: apps.map((a) => a.jobId) } }).select("title").lean()).map((j) => [String(j._id), j.title]));
  const users = await usersById([...verifs.map((v) => v.employerUserId), ...apps.map((a) => a.userId)]);
  const appById = new Map(apps.map((a) => [String(a._id), a]));
  const suspected = await EmployerCompanyVerification.find({ status: "duplicate_review" }).select("companyGroupKey").lean();
  ok(req, res, {
    trials: list.map((t) => {
      const members = verifs.filter((v) => v.companyGroupKey === t.companyGroupKey);
      const a = t.consumedByApplicationId ? appById.get(String(t.consumedByApplicationId)) : null;
      return {
        id: String(t._id), companyGroupKey: t.companyGroupKey, companyName: members.find((v) => v.status === "approved")?.companyName || members[0]?.companyName || "",
        status: t.eligibilityStatus, entitlementCount: t.entitlementCount, consumedCount: t.consumedCount, consumedAt: t.consumedAt, fraudReviewStatus: t.fraudReviewStatus, reviewReason: t.reviewReason,
        usedBy: a ? { applicationId: String(a._id), job: jobs.get(String(a.jobId)) || "", candidateFirstName: String(users.get(String(a.userId))?.name || "").split(" ")[0] } : null,
        employers: members.map((v) => ({ id: String(v.employerUserId), name: users.get(String(v.employerUserId))?.name || "", status: v.status })),
        suspectedDuplicates: suspected.filter((x) => x.companyGroupKey === t.companyGroupKey).length,
        version: t.version, history: t.history, activatedAt: t.createdAt, policyVersion: t.policyVersion,
      };
    }),
    suspectedDuplicates: suspected.length,
  });
}));

router.post("/admin/trials/:id/review", ...admin, handle(async (req, res) => {
  const { action, reason } = req.body || {};
  const t = await trial.reviewTrial(req.userId, req.params.id, { action, reason });
  await require("../services/adminActionLog").recordSafe({ adminId: req.userId, action: "fhf.trial.review", targetType: "EmployerHiringTrial", targetId: String(req.params.id), before: null, after: { action: String(action || ""), status: t.eligibilityStatus, consumedCount: t.consumedCount, entitlementCount: t.entitlementCount, fraudReviewStatus: t.fraudReviewStatus }, reason, requestId: req.id });
  ok(req, res, { id: String(t._id), status: t.eligibilityStatus, consumedCount: t.consumedCount, entitlementCount: t.entitlementCount, fraudReviewStatus: t.fraudReviewStatus, version: t.version });
}));

router.get("/admin/billing-events", ...admin, handle(async (req, res) => {
  const filter = {};
  if (req.query.companyGroupKey) filter.companyGroupKey = String(req.query.companyGroupKey).slice(0, 80);
  if (req.query.eventType) filter.eventType = String(req.query.eventType);
  const list = await EmployerHiringBillingEvent.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const users = await usersById(list.map((b) => b.employerUserId));
  ok(req, res, list.map((b) => ({ id: String(b._id), companyGroupKey: b.companyGroupKey, employer: { id: String(b.employerUserId), name: users.get(String(b.employerUserId))?.name || "" }, applicationId: b.applicationId ? String(b.applicationId) : null, eventType: b.eventType, feeWaived: b.feeWaived, amount: b.amount, currency: b.currency, policyVersion: b.policyVersion, note: b.note, createdAt: b.createdAt })));
}));

router.get("/admin/audit", ...admin, handle(async (req, res) => {
  const filter = isId(req.query.targetId) ? { targetId: req.query.targetId } : {};
  ok(req, res, (await CareerAdminAudit.find(filter).sort({ at: -1 }).limit(200).lean()).map((a) => ({ id: String(a._id), admin: String(a.admin), action: a.action, targetType: a.targetType, targetId: String(a.targetId), reason: a.reason, before: a.before, after: a.after, at: a.at })));
}));

router.get("/admin/employers/company-status", ...admin, handle(async (req, res) => {
  const list = await EmployerCompanyVerification.find({}).select("employerUserId status companyName").lean();
  ok(req, res, Object.fromEntries(list.map((v) => [String(v.employerUserId), { status: v.status, companyName: v.companyName }])));
}));

module.exports = router;

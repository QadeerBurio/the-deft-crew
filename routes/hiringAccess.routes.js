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
// the menu chip: not submitted / under review / verified / needs info (a rejection also needs the employer's action)
const chipOf = (v) => (!v ? "not_submitted" : v.status === "approved" ? "verified" : ["rejected", "needs_info"].includes(v.status) ? "needs_info" : "under_review");
const docView = (x) => ({ id: String(x.documentId), kind: x.kind, fileName: x.fileName, mimeType: x.mimeType, size: x.size, uploadedAt: x.uploadedAt });
async function myVerification(employerId) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean();
  const pending = (await pendingJobsOf([employerId])).get(String(employerId)) || [];
  const chip = chipOf(v);
  return {
    verified: v?.status === "approved",
    chip,
    verification: v ? {
      id: String(v._id), status: v.status, companyName: v.companyName, registrationType: v.registrationType, ntnOrSecp: v.ntnOrSecp,
      businessEmailDomain: v.businessEmailDomain || "", website: v.website || "", documents: (v.documents || []).map(docView),
      reason: v.reason || "", reviewedAt: v.reviewedAt, submittedAt: v.createdAt,
    } : null,
    // what tdc said when it rejected the details or asked for more (the employer fixes it and sends again)
    actionNeeded: v && ["rejected", "needs_info"].includes(v.status) ? { status: v.status, reason: v.reason || "" } : null,
    pendingJobs: pending,
    message: v?.status === "approved" ? null : "Your jobs go live once your company is verified by tdc.",
  };
}

// ---------- uploaded proof (private: stored in the database, only admins can open it) ----------
const multer = require("multer");
const crypto = require("crypto");
const EmployerVerificationDocument = require("../models/EmployerVerificationDocument");
const MAX_BYTES = 5 * 1024 * 1024;
const MIME = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
// the file's own first bytes must match its type (a renamed file is refused)
const looksLike = (buf, mime) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (mime === "application/pdf") return buf.slice(0, 5).toString("latin1") === "%PDF-";
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === "image/png") return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/webp") return buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP";
  return false;
};
const uploadProof = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }).single("file");
const receiveFile = (req, res, next) => uploadProof(req, res, (err) => {
  if (err?.code === "LIMIT_FILE_SIZE") return fail(req, res, 413, "FILE_TOO_LARGE", "The file is over 5 MB", { field: "file" });
  if (err) return fail(req, res, 400, "UPLOAD_FAILED", "Couldn't read the file", { field: "file" });
  next();
});
//   POST /employers/me/company-verification/documents   multipart: file (PDF / JPEG / PNG / WebP, max 5 MB), kind
//        (ntn_certificate | secp_certificate | business_registration | letterhead) -> { id, kind, fileName, ... };
//        then send its id in documentIds with the details
router.post("/employers/me/company-verification/documents", ...employer, receiveFile, handle(async (req, res) => {
  const kind = String(req.body?.kind || "");
  if (!EmployerVerificationDocument.KINDS.includes(kind)) return fail(req, res, 400, "INVALID_KIND", "Choose what the document is: NTN certificate, SECP certificate, business registration or letterhead", { field: "kind" });
  const file = req.file;
  if (!file) return fail(req, res, 400, "FILE_REQUIRED", "Choose a file", { field: "file" });
  if (!MIME[file.mimetype] || !looksLike(file.buffer, file.mimetype)) return fail(req, res, 400, "INVALID_FILE_TYPE", "Upload a PDF or an image (JPEG, PNG or WebP)", { field: "file" });
  const v = await EmployerCompanyVerification.findOne({ employerUserId: req.userId }).select("status").lean();
  if (v?.status === "approved") return fail(req, res, 409, "ALREADY_APPROVED", "Your company is verified; contact tdc to change its details");
  if ((await EmployerVerificationDocument.countDocuments({ employerUserId: req.userId })) >= 20) return fail(req, res, 429, "TOO_MANY_UPLOADS", "That's a lot of uploads: contact tdc");
  const name = String(file.originalname || "").replace(/[^\w .()-]/g, "_").slice(0, 120) || `document.${MIME[file.mimetype]}`;
  const doc = await EmployerVerificationDocument.create({ employerUserId: req.userId, kind, fileName: name, mimeType: file.mimetype, size: file.size, sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"), data: file.buffer });
  ok(req, res, { id: String(doc._id), kind, fileName: name, mimeType: file.mimetype, size: file.size, uploadedAt: doc.createdAt }, 201);
}));
//   GET  /employers/me/company-verification   { verified, chip, verification, actionNeeded, pendingJobs, message }
//   POST /employers/me/company-verification   { companyName, registrationType, ntnOrSecp, businessEmailDomain?, website?,
//                                              documentIds? } — at least one of domain, website, document
router.get("/employers/me/company-verification", ...employer, handle(async (req, res) => ok(req, res, await myVerification(req.userId))));
router.post("/employers/me/company-verification", ...employer, handle(async (req, res) => {
  const { created } = await trialService.submitVerification(req.userId, req.body || {});
  ok(req, res, await myVerification(req.userId), created ? 201 : 200);
}));
//   GET  /admin/company-verifications?status   each with the employer's jobs waiting for it
//   POST /admin/company-verifications/:id/review  { action: approve|reject|request_info|mark_duplicate, reason,
//                                              separateGroup? }; approve publishes the waiting jobs
//   GET  /admin/company-verifications/:id/documents/:documentId   the uploaded file (admins only; logged)
router.get("/admin/company-verifications", ...admin, handle(async (req, res) => {
  const st = String(req.query.status || "pending");
  const list = await EmployerCompanyVerification.find(st === "all" ? {} : { status: st }).sort({ createdAt: -1 }).limit(300).lean();
  const trialRoutes = require("./careerTrial.routes");
  const users = await trialRoutes.usersById(list.flatMap((v) => [v.employerUserId, ...(v.duplicateOf || []).map((d) => d.employerUserId)]));
  const pending = await pendingJobsOf(list.map((v) => v.employerUserId));
  ok(req, res, list.map((v) => ({ ...trialRoutes.verificationView(v, users), pendingJobs: pending.get(String(v.employerUserId)) || [] })));
}));
router.get("/admin/company-verifications/:id/documents/:documentId", ...admin, handle(async (req, res) => {
  if (!isId(req.params.id) || !isId(req.params.documentId)) return fail(req, res, 404, "NOT_FOUND", "Document not found");
  const v = await EmployerCompanyVerification.findById(req.params.id).select("employerUserId documents").lean();
  // only a document attached to this verification, uploaded by its employer
  if (!v || !(v.documents || []).some((x) => String(x.documentId) === String(req.params.documentId))) return fail(req, res, 404, "NOT_FOUND", "Document not found");
  const doc = await EmployerVerificationDocument.findOne({ _id: req.params.documentId, employerUserId: v.employerUserId }).select("+data").lean();
  if (!doc || !doc.data) return fail(req, res, 404, "NOT_FOUND", "Document not found");
  await AdminLog.recordSafe({ adminId: req.userId, action: "employer.verification.document_open", targetType: "EmployerVerificationDocument", targetId: String(doc._id), before: null, after: { verificationId: String(v._id), kind: doc.kind }, reason: "", requestId: req.id });
  const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data.buffer || doc.data);
  res.set("Content-Type", doc.mimeType);
  res.set("Content-Disposition", `inline; filename="${String(doc.fileName || "document").replace(/["\\\r\n]/g, "_")}"`);
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.send(data);
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

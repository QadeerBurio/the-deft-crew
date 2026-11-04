// routes/careerResume.routes.js — /api/career/resume (services/resumeStudio/). Behind FLAG_RESUME_STUDIO_V2:
// flag off for the caller = 404, and the old /api/resume routes are unchanged.
// Replies: { success: true, data, requestId } or { success: false, error: { code, message, ... }, requestId }.
//
// Student (owner only):
//   GET    /sources/:resumeId                  is this resume verified? (an uploaded one needs confirming)
//   POST   /sources/:resumeId/confirm          { revisionHash } I checked the details read from my upload
//   POST   /tailor-jobs                        { resumeId, jobId | jobTitle + jobDescription, idempotencyKey } -> 202
//   GET    /tailor-jobs/:id                    poll: queued | running | succeeded (draftId) | failed (errorCode)
//   GET    /drafts/:id                         suggestions, match explanation, current content
//   PATCH  /drafts/:id/decisions               { revision, decisions: [...] } (409 on a stale revision)
//   GET    /drafts/:id/preview.pdf             ATS Classic PDF with a DRAFT label
//   POST   /drafts/:id/approve                 { revision, confirmAccurate, confirmReviewed, label? } (idempotent)
//   DELETE /drafts/:id
//   GET    /versions                           my approved versions
//   GET    /versions/:id                       one version, with its snapshot
//   GET    /versions/:id/export.pdf            the approved PDF (no DRAFT label)
//   DELETE /versions/:id                       only if never used in an application
//   POST   /applications/:applicationId/attach-version   { versionId } send this version with my application
// Student who applied, or the employer who posted the job (nobody else):
//   GET    /applications/:applicationId/resume           which version was sent (metadata)
//   GET    /applications/:applicationId/resume.pdf       exactly that snapshot
const express = require("express");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const CareerResumeTailorJob = require("../models/CareerResumeTailorJob");
const CareerResumeDraft = require("../models/CareerResumeDraft");
const CareerResumeApprovedVersion = require("../models/CareerResumeApprovedVersion");
const CareerApplicationResumeAttachment = require("../models/CareerApplicationResumeAttachment");
const CareerResumeSourceConfirmation = require("../models/CareerResumeSourceConfirmation");
const { isEnabled } = require("../config/featureFlags");
const { StudioError } = require("../services/resumeStudio/tailor");
const { buildVerifiedFacts, revisionHashOf } = require("../services/resumeStudio/facts");
const { requirementsFor } = require("../services/resumeStudio/jobRequirements");
const injection = require("../services/resumeStudio/injection");
const worker = require("../services/resumeStudio/worker");
const drafts = require("../services/resumeStudio/drafts");
const { render } = require("../services/resumeStudio/renderer");

const router = express.Router();
const { isId } = worker;
const RETAIN_MS = 2 * 365 * 24 * 3600 * 1000;

const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra }, requestId: req.id || null });
const STATUS = {
  NOT_FOUND: 404, RESUME_NOT_FOUND: 404, SOURCE_UNVERIFIED: 409, SOURCE_CHANGED: 409, STALE_REVISION: 409, ALREADY_APPROVED: 409,
  ALREADY_ATTACHED: 409, VERSION_IN_USE: 409, RATE_LIMITED: 429, TOO_MANY_RUNNING: 429,
};
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof StudioError) {
      const { code, message, ...extra } = err;
      return fail(req, res, STATUS[code] || 422, code, message, extra);
    }
    console.error("[career-resume]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};

// signed in, the flag on for this user; role from the database (never from the token alone)
const gate = (...roles) => async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  if (!isEnabled("resumeStudioV2", { id: String(req.userId), role: u.role })) return fail(req, res, 404, "STUDIO_OFF", "Resume Studio is not available for your account yet");
  if (roles.length && !roles.includes(u.role)) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  req.studioRole = u.role;
  next();
};
const student = [auth, gate("student")];
const anyone = [auth, gate()];
// every PDF is rendered on the server: per-user limit, shared by previews, exports and the employer's copy
// (RATE_LIMIT_RESUME_PDF_MAX / _WINDOW_MIN, utils/userRateLimit.js)
const pdfLimit = require("../utils/userRateLimit").perUser("resume_pdf");
const sendPdf = (res, buf, name) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${String(name).replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 80) || "resume"}.pdf"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(buf);
};
const ownResume = (req) => (isId(req.params.resumeId || req.body?.resumeId) ? Resume.findOne({ _id: req.params.resumeId || req.body.resumeId, user: req.userId }).lean() : null);

// ---------- source verification ----------
router.get("/sources/:resumeId", ...student, handle(async (req, res) => {
  const resume = await ownResume(req);
  if (!resume) return fail(req, res, 404, "NOT_FOUND", "Resume not found");
  const built = buildVerifiedFacts(resume, await worker.confirmationFor(resume));
  ok(req, res, { resumeId: String(resume._id), provenance: built.provenance, verified: built.verified, revisionHash: built.revisionHash, facts: built.facts.map((f) => ({ factId: f.factId, type: f.type, value: f.value })) });
}));

router.post("/sources/:resumeId/confirm", ...student, handle(async (req, res) => {
  const resume = await ownResume(req);
  if (!resume) return fail(req, res, 404, "NOT_FOUND", "Resume not found");
  const revisionHash = revisionHashOf(resume);
  if (String(req.body?.revisionHash || "") !== revisionHash) return fail(req, res, 409, "SOURCE_CHANGED", "Your resume changed. Please check the details again.");
  await CareerResumeSourceConfirmation.updateOne({ userId: req.userId, resumeId: resume._id, revisionHash }, { $setOnInsert: { confirmedAt: new Date() } }, { upsert: true });
  ok(req, res, { resumeId: String(resume._id), revisionHash, verified: true });
}));

// ---------- tailor jobs ----------
const jobView = (j) => ({ id: String(j._id), status: j.status, draftId: j.draftId ? String(j.draftId) : null, errorCode: j.errorCode || null, target: { kind: j.target?.kind, jobId: j.target?.jobId ? String(j.target.jobId) : null, title: j.target?.title || "" }, pollAfterMs: ["queued", "running"].includes(j.status) ? 1500 : null, createdAt: j.createdAt });

router.post("/tailor-jobs", ...student, handle(async (req, res) => {
  const { resumeId, jobId, jobTitle, jobDescription, idempotencyKey } = req.body || {};
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return fail(req, res, 400, "IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey (8-80 letters, digits, - or _) is required");
  const existing = await CareerResumeTailorJob.findOne({ userId: req.userId, idempotencyKey: key }).lean();
  if (existing) return ok(req, res, jobView(existing), 202); // a duplicate tap
  if (!isId(resumeId)) return fail(req, res, 400, "RESUME_REQUIRED", "Choose one of your resumes");
  const resume = await ownResume(req);
  if (!resume) return fail(req, res, 404, "NOT_FOUND", "Resume not found");
  const built = buildVerifiedFacts(resume, await worker.confirmationFor(resume));
  if (!built.verified) return fail(req, res, 409, "SOURCE_UNVERIFIED", "Please check and confirm the details read from your uploaded resume first.", { revisionHash: built.revisionHash });

  let target;
  let jobSnapshot;
  if (jobId) {
    if (!isId(jobId)) return fail(req, res, 400, "INVALID_JOB", "Invalid job");
    const job = await Job.findById(jobId).select("title description requirements responsibilities skills active archivedAt").lean();
    if (!job || job.active === false || job.archivedAt) return fail(req, res, 404, "JOB_NOT_FOUND", "This job is no longer open");
    const text = [job.description, ...(job.requirements || []), ...(job.responsibilities || []), ...(job.skills || [])].filter((x) => typeof x === "string").join("\n");
    jobSnapshot = await requirementsFor({ title: job.title || "", description: text });
    target = { kind: "tdc_job", jobId: job._id, title: String(job.title || "").slice(0, 200), descriptionHash: jobSnapshot.hash };
  } else {
    const text = String(jobDescription || "");
    if (text.trim().length < 80) return fail(req, res, 400, "JOB_DESCRIPTION_REQUIRED", "Paste the full job description (at least a few sentences)");
    if (text.length > injection.MAX_JOB_CHARS) return fail(req, res, 400, "JOB_DESCRIPTION_TOO_LONG", `Job descriptions can be up to ${injection.MAX_JOB_CHARS} characters`);
    jobSnapshot = await requirementsFor({ title: String(jobTitle || "").slice(0, 200), description: text });
    target = { kind: "pasted", jobId: null, title: String(jobTitle || "").replace(/\s+/g, " ").trim().slice(0, 200), descriptionHash: jobSnapshot.hash };
  }
  delete jobSnapshot.cached;

  await worker.checkLimits(req.userId);
  let job;
  try {
    job = await CareerResumeTailorJob.create({ userId: req.userId, resumeId: resume._id, idempotencyKey: key, target, jobSnapshot });
  } catch (e) {
    if (e?.code !== 11000) throw e;
    return ok(req, res, jobView(await CareerResumeTailorJob.findOne({ userId: req.userId, idempotencyKey: key }).lean()), 202);
  }
  worker.schedule(job._id);
  ok(req, res, jobView(job), 202);
}));

router.get("/tailor-jobs/:id", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Not found");
  let job = await CareerResumeTailorJob.findOne({ _id: req.params.id, userId: req.userId }).lean();
  if (!job) return fail(req, res, 404, "NOT_FOUND", "Not found");
  if (["queued", "running"].includes(job.status)) job = await worker.recoverIfStale(job);
  ok(req, res, jobView(job));
}));

// ---------- drafts ----------
const ownDraft = async (req) => (isId(req.params.id) ? CareerResumeDraft.findOne({ _id: req.params.id, userId: req.userId }).lean() : null);

router.get("/drafts/:id", ...student, handle(async (req, res) => {
  const d = await ownDraft(req);
  if (!d) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  ok(req, res, drafts.studentView(d));
}));

router.patch("/drafts/:id/decisions", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  ok(req, res, drafts.studentView(await drafts.decide(req.userId, req.params.id, req.body || {})));
}));

router.get("/drafts/:id/preview.pdf", ...student, pdfLimit, handle(async (req, res) => {
  const d = await ownDraft(req);
  if (!d) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  sendPdf(res, await render(drafts.contentWithDecisions(d), { draft: true }), `DRAFT ${d.target?.title || "resume"}`);
}));

router.post("/drafts/:id/approve", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  const { version, created } = await drafts.approve(req.userId, req.params.id, req.body || {});
  ok(req, res, { version: drafts.versionView(version), created }, created ? 201 : 200);
}));

router.delete("/drafts/:id", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  const r = await CareerResumeDraft.deleteOne({ _id: req.params.id, userId: req.userId });
  if (!r.deletedCount) return fail(req, res, 404, "NOT_FOUND", "Draft not found");
  ok(req, res, { deleted: true }); // an approved version made from it stays
}));

// ---------- versions ----------
router.get("/versions", ...student, handle(async (req, res) => {
  const list = await CareerResumeApprovedVersion.find({ userId: req.userId }).select("-contentSnapshot").sort({ approvedAt: -1 }).limit(100).lean();
  ok(req, res, list.map(drafts.versionView));
}));

const ownVersion = (req) => (isId(req.params.id) ? CareerResumeApprovedVersion.findOne({ _id: req.params.id, userId: req.userId }).lean() : null);

router.get("/versions/:id", ...student, handle(async (req, res) => {
  const v = await ownVersion(req);
  if (!v) return fail(req, res, 404, "NOT_FOUND", "Version not found");
  ok(req, res, { ...drafts.versionView(v), content: v.contentSnapshot });
}));

router.get("/versions/:id/export.pdf", ...student, pdfLimit, handle(async (req, res) => {
  const v = await ownVersion(req);
  if (!v) return fail(req, res, 404, "NOT_FOUND", "Version not found");
  sendPdf(res, await render(v.contentSnapshot), v.label || "resume");
}));

router.delete("/versions/:id", ...student, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Version not found");
  const v = await ownVersion(req);
  if (!v) return fail(req, res, 404, "NOT_FOUND", "Version not found");
  if (v.usedInApplication || (await CareerApplicationResumeAttachment.exists({ versionId: v._id }))) {
    return fail(req, res, 409, "VERSION_IN_USE", "This version was sent with an application, so it's kept for 2 years.");
  }
  await CareerResumeApprovedVersion.deleteOne({ _id: v._id, userId: req.userId, usedInApplication: { $ne: true } });
  ok(req, res, { deleted: true });
}));

// ---------- applications ----------
router.post("/applications/:applicationId/attach-version", ...student, handle(async (req, res) => {
  const { applicationId } = req.params;
  const versionId = req.body?.versionId;
  if (!isId(applicationId) || !isId(versionId)) return fail(req, res, 400, "INVALID_ID", "Invalid application or version");
  const application = await JobApplication.findOne({ _id: applicationId, userId: req.userId }).select("jobId userId").lean();
  if (!application) return fail(req, res, 404, "NOT_FOUND", "Application not found");
  const version = await CareerResumeApprovedVersion.findOne({ _id: versionId, userId: req.userId }).lean();
  if (!version) return fail(req, res, 404, "NOT_FOUND", "Version not found");
  if (version.target?.kind !== "tdc_job" || String(version.target.jobId) !== String(application.jobId)) {
    return fail(req, res, 422, "VERSION_FOR_ANOTHER_JOB", "This version was tailored for a different job. Tailor your resume for this job first.");
  }
  const job = await Job.findById(application.jobId).select("postedBy").lean();
  const retainUntil = new Date(Date.now() + RETAIN_MS);
  let attachment;
  try {
    attachment = (await CareerApplicationResumeAttachment.create({ applicationId: application._id, jobId: application.jobId, userId: req.userId, employerId: job?.postedBy || null, versionId: version._id, contentHash: version.contentHash, retainUntil })).toObject();
  } catch (e) {
    if (e?.code !== 11000) throw e;
    attachment = await CareerApplicationResumeAttachment.findOne({ applicationId: application._id }).lean();
    if (String(attachment.versionId) !== String(version._id)) return fail(req, res, 409, "ALREADY_ATTACHED", "A resume is already attached to this application.");
    return ok(req, res, attachmentView(attachment, version)); // the same tap again
  }
  await CareerResumeApprovedVersion.updateOne({ _id: version._id }, { $set: { usedInApplication: true, retainUntil } });
  ok(req, res, attachmentView(attachment, version), 201);
}));

const attachmentView = (a, v) => ({ applicationId: String(a.applicationId), jobId: String(a.jobId), versionId: String(a.versionId), label: v?.label || "", contentHash: a.contentHash, attachedAt: a.attachedAt, templateId: v?.templateId || "ats-classic" });

// the student who applied, or the employer who posted the job; anyone else gets 404
async function attachmentFor(req) {
  if (!isId(req.params.applicationId)) return null;
  const a = await CareerApplicationResumeAttachment.findOne({ applicationId: req.params.applicationId }).lean();
  if (!a) return null;
  if (String(a.userId) !== String(req.userId)) {
    const job = await Job.findById(a.jobId).select("postedBy").lean();
    if (!job || String(job.postedBy) !== String(req.userId)) return null;
  }
  const v = await CareerResumeApprovedVersion.findById(a.versionId).lean();
  if (!v || v.contentHash !== a.contentHash) return null; // only the exact snapshot that was sent
  return { a, v };
}

router.get("/applications/:applicationId/resume", ...anyone, handle(async (req, res) => {
  const found = await attachmentFor(req);
  if (!found) return fail(req, res, 404, "NOT_FOUND", "No tailored resume for this application");
  ok(req, res, attachmentView(found.a, found.v));
}));

router.get("/applications/:applicationId/resume.pdf", ...anyone, pdfLimit, handle(async (req, res) => {
  const found = await attachmentFor(req);
  if (!found) return fail(req, res, 404, "NOT_FOUND", "No tailored resume for this application");
  const pi = found.v.contentSnapshot?.personalInfo || {};
  sendPdf(res, await render(found.v.contentSnapshot), `${pi.firstName || ""} ${pi.lastName || ""} resume`.trim());
}));

module.exports = router;

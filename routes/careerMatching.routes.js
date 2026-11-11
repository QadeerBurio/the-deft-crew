// routes/careerMatching.routes.js — /api/career/matching (services/career/matchingService.js), behind
// FLAG_CAREER_MATCHING for BOTH the job's employer and the candidate. Decision support only: nothing here changes,
// rejects or hides an application.
//   GET /applications/:id     one application's match: mandatory criteria (met / not met / unknown) and the
//                             skill evidence (matched / missing / unknown, with the resume text). The job's
//                             employer, or an admin (audited). 404 MATCHING_OFF when the flag isn't on for both.
//   GET /jobs/:jobId          every application on the employer's job with its estimate and criteria counts.
//                             ?sort=newest (default) | relevance (estimate high to low, "insufficient" last, ties
//                             newest first). Applications outside the pilot are listed too, with match: null.
//                             Each match has a quality band (strong >= 70, medium 40-69, weak < 40, insufficient), and
//                             summary counts them: an estimate from the resumes, not a judgment of the candidates.
//   GET /recommended              ?limit= (max 30): open jobs that match the signed-in student's resume (score >= 60, no
//                                 mandatory criterion "not met"), with the matched skills and where the resume shows
//                                 them. Students with FLAG_CAREER_MATCHING only (404 MATCHING_OFF otherwise).
//   GET /jobs/:jobId/suggested    students who opted in (discoverable), haven't applied and match 70%+ of the job's
//                                 skills: an anonymous label, the estimate, matched skills and the resume section only
//                                 (never a name, university, city, contact or id). The job's employer, with
//                                 FLAG_CAREER_MATCHING and FLAG_CAREER_TIMELINE.
//   POST /jobs/:jobId/suggested/:token/invite   invite one to apply (max 20 per job a day); the student decides
// A match is computed once per (job version, resume version) and stored (CareerMatchSnapshot): a change to the
// job or to the candidate's resume gives a new fingerprint and a fresh computation; nothing else does.
const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const Resume = require("../models/Resume");
const CareerApplicationResumeAttachment = require("../models/CareerApplicationResumeAttachment");
const CareerResumeApprovedVersion = require("../models/CareerResumeApprovedVersion");
const CareerMatchSnapshot = require("../models/CareerMatchSnapshot");
const matching = require("../services/career/matchingService");
const { isEnabled } = require("../config/featureFlags");
const { recordSafe } = require("../services/domainEvents");

const router = express.Router();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => a != null && b != null && String(a) === String(b);
const ok = (req, res, data) => res.json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message) => res.status(status).json({ success: false, error: { code, message }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error("[career-matching]", err?.message);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
const flagOn = (id, role) => !!id && isEnabled("careerMatching", { id: String(id), role });
const pilot = (job, app) => !!job?.postedBy && flagOn(job.postedBy, "employee") && flagOn(app.userId, "student");

const signedIn = async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  req.matchRole = u.role;
  next();
};

// the resume this application is matched against
async function sourceFor(app) {
  const att = await CareerApplicationResumeAttachment.findOne({ applicationId: app._id }).lean();
  if (att) {
    const v = await CareerResumeApprovedVersion.findById(att.versionId).select("contentSnapshot contentHash").lean();
    if (v && v.contentHash === att.contentHash && !v.contentSnapshot?.anonymised) return { source: { kind: "tailored_version", id: v._id }, profile: matching.profileOf({ content: v.contentSnapshot }) };
  }
  const resume = await Resume.findOne({ user: app.userId }).sort({ updatedAt: -1 }).select("personalInfo professionalSummary workExperience education projects skills certifications languages careerProfile").lean();
  if (resume) return { source: { kind: "resume", id: resume._id }, profile: matching.profileOf({ resume }) };
  return { source: { kind: "none", id: null }, profile: matching.profileOf({ content: { personalInfo: {}, professionalSummary: {}, workExperience: [], education: [], projects: [], skills: [], certifications: [], languages: [] } }) };
}

/** The current match for an application: the stored one if neither the job nor the resume changed */
async function matchFor(app, job) {
  const { source, profile } = await sourceFor(app);
  const statedYears = Number(app.yearsOfExperience) > 0 ? Number(app.yearsOfExperience) : null;
  const keys = { application: app._id, modelVersion: matching.MODEL_VERSION, jobFingerprint: matching.jobFingerprint(job), profileFingerprint: matching.profileFingerprint(profile, statedYears) };
  const found = await CareerMatchSnapshot.findOne(keys).lean();
  if (found) return found;
  const m = matching.match(job, profile, { statedYears });
  const doc = { ...keys, job: job._id, candidate: app.userId, employer: job.postedBy || null, source, relevance: m.relevance, mandatory: m.mandatory, mandatorySummary: m.mandatorySummary, skills: m.skills, evidenceSummary: m.evidenceSummary, computedAt: new Date() };
  try {
    return (await CareerMatchSnapshot.create(doc)).toObject();
  } catch (err) {
    if (err?.code === 11000) return CareerMatchSnapshot.findOne(keys).lean(); // computed by a simultaneous request
    throw err;
  }
}

const view = (s) => ({
  applicationId: String(s.application),
  modelVersion: s.modelVersion,
  computedAt: s.computedAt,
  source: s.source.kind,
  relevance: s.relevance,
  mandatory: s.mandatory,
  mandatorySummary: s.mandatorySummary,
  skills: s.skills,
  evidenceSummary: s.evidenceSummary,
  note: "Decision support only: an estimate from the resume, not a hiring prediction. Nothing is rejected or hidden automatically.",
});

router.get("/recommended", auth, signedIn, handle(async (req, res) => {
  const recs = require("../services/career/recommendations");
  if (req.matchRole !== "student") return fail(req, res, 404, "NOT_FOUND", "Recommendations are for students");
  if (!recs.inPilot(req.userId)) return fail(req, res, 404, "MATCHING_OFF", "Recommendations aren't available for your account yet");
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
  const r = await recs.recommend(req.userId, { limit });
  ok(req, res, {
    modelVersion: matching.MODEL_VERSION, formula: matching.FORMULA, minScore: recs.DEFAULT_MIN_SCORE, hasResume: r.hasResume,
    note: "Jobs whose listed skills your resume shows evidence for. An estimate from your resume, not a promise of an interview.",
    recommendations: r.recommendations,
  });
}));

const inviteHandle = (fn) => handle(async (req, res) => {
  const invites = require("../services/career/invites");
  if (req.matchRole !== "employee") return fail(req, res, 404, "NOT_FOUND", "Job not found");
  try { ok(req, res, await fn(invites, req)); } catch (err) {
    if (err instanceof invites.InviteError) return fail(req, res, err.status, err.code, err.message);
    throw err;
  }
});
router.get("/jobs/:jobId/suggested", auth, signedIn, inviteHandle((invites, req) => (isId(req.params.jobId) ? invites.suggested(req.params.jobId, req.userId) : Promise.reject(new invites.InviteError(404, "NOT_FOUND", "Job not found")))));
router.post("/jobs/:jobId/suggested/:token/invite", auth, signedIn, inviteHandle((invites, req) => (isId(req.params.jobId) ? invites.invite(req.params.jobId, req.userId, req.params.token) : Promise.reject(new invites.InviteError(404, "NOT_FOUND", "Job not found")))));

router.get("/applications/:id", auth, signedIn, handle(async (req, res) => {
  if (!isId(req.params.id)) return fail(req, res, 404, "NOT_FOUND", "Application not found");
  const app = await JobApplication.findById(req.params.id).select("jobId userId yearsOfExperience appliedAt").lean();
  const job = app && (await Job.findById(app.jobId).select("title skills requirements minExperience education postedBy isExternal").lean());
  const admin = req.matchRole === "admin";
  // not this job's employer: it doesn't exist for them
  if (!app || !job || (!admin && !(req.matchRole === "employee" && same(job.postedBy, req.userId)))) return fail(req, res, 404, "NOT_FOUND", "Application not found");
  if (!pilot(job, app)) return fail(req, res, 404, "MATCHING_OFF", "Candidate matching isn't available for this application");
  const s = await matchFor(app, job);
  if (admin) await recordSafe("career.admin.access", `${req.userId}:${app._id}:read:match:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, { actor: req.userId, subject: { kind: "JobApplication", id: app._id }, data: { action: "read:match" } });
  ok(req, res, view(s));
}));

router.get("/jobs/:jobId", auth, signedIn, handle(async (req, res) => {
  if (!isId(req.params.jobId)) return fail(req, res, 404, "NOT_FOUND", "Job not found");
  const job = await Job.findById(req.params.jobId).select("title skills requirements minExperience education postedBy isExternal").lean();
  if (!job || req.matchRole !== "employee" || !same(job.postedBy, req.userId)) return fail(req, res, 404, "NOT_FOUND", "Job not found");
  if (!flagOn(req.userId, "employee")) return fail(req, res, 404, "MATCHING_OFF", "Candidate matching isn't available for your account yet");
  const sort = req.query.sort === "relevance" ? "relevance" : "newest";
  const apps = await JobApplication.find({ jobId: job._id }).select("userId yearsOfExperience appliedAt").sort({ appliedAt: -1 }).limit(500).lean();
  const rows = [];
  for (const app of apps) {
    const s = pilot(job, app) ? await matchFor(app, job) : null;
    rows.push({ applicationId: String(app._id), appliedAt: app.appliedAt, match: s ? { score: s.relevance.score, quality: matching.qualityOf(s.relevance.score), insufficient: s.relevance.insufficient, label: s.relevance.label, mandatorySummary: s.mandatorySummary, computedAt: s.computedAt } : null });
  }
  if (sort === "relevance") {
    const key = (r) => (r.match && r.match.score != null ? r.match.score : -1);
    rows.sort((a, b) => key(b) - key(a) || new Date(b.appliedAt) - new Date(a.appliedAt));
  }
  const summary = { ...matching.qualitySummary(rows), note: "An estimate from each resume's skill evidence, not a judgment of the candidates. Nobody is ranked out or hidden." };
  ok(req, res, { sort, modelVersion: matching.MODEL_VERSION, formula: matching.FORMULA, summary, applications: rows });
}));

module.exports = router;
module.exports.matchFor = matchFor;

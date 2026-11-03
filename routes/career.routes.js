// routes/career.routes.js — /api/career (services/career/). Behind FLAG_CAREER_TIMELINE (employer AND candidate).
// Replies: { success: true, data, requestId } or { success: false, error: { code, message, ... }, requestId }.
// Writes take the version the caller last saw ("version") and an optional Idempotency-Key header.
//
//   GET  /applications/me                  candidate: my applications with stage, next actions
//   GET  /applications/:id/timeline        candidate (own) / employer (own job) / admin (audited)
//   POST /applications/:id/events          { type, version, note, internalNote } — review, shortlist, reject,
//                                          withdraw, disputes, no-show reports; interviews / offers have routes
//   GET  /employers/me/applications        employer: applicants of my jobs, by stage (Kanban)
//   POST /interviews                       employer: { applicationId, version, startsAt, durationMinutes,
//                                          timezone (Asia/Karachi), mode, meetingLink | location, note }
//   POST /interviews/:id/reschedule|cancel employer
//   POST /interviews/:id/respond           candidate: accept | decline | reschedule | employer_no_show | dispute
//   POST /interviews/:id/complete          employer: completed | candidate_no_show
//   GET  /interviews/:id, /interviews/:id/ics   either side (.ics: stable UID, SEQUENCE per change)
const express = require("express");
const auth = require("../middleware/auth.middleware");
const User = require("../models/User");
const Job = require("../models/Job");
const JobApplication = require("../models/JobApplication");
const CareerApplicationEvent = require("../models/CareerApplicationEvent");
const timeline = require("../services/career/careerTimelineService");
const interviews = require("../services/career/careerInterviewService");

const router = express.Router();
const { CareerError, isId } = timeline;

const ok = (req, res, data, status = 200) => res.status(status).json({ success: true, data, requestId: req.id || null });
const fail = (req, res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: { code, message, ...extra }, requestId: req.id || null });
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof CareerError) return fail(req, res, err.status, err.code, err.message, err.extra);
    console.error("[career]", err);
    return fail(req, res, 500, "SERVER_ERROR", "Something went wrong");
  }
};
// the signed-in user's role, from the database
const role = (...roles) => async (req, res, next) => {
  if (req.isGuest || !isId(req.userId)) return fail(req, res, 401, "SIGN_IN", "Sign in first");
  const u = await User.findById(req.userId).select("role").lean();
  if (!u || !roles.includes(u.role)) return fail(req, res, 403, "FORBIDDEN", "Not allowed for your account");
  req.careerRole = u.role;
  next();
};
const idemKey = (req) => (req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim() || null;

// many applications' states in one query
async function statesFor(apps) {
  const events = apps.length ? await CareerApplicationEvent.find({ application: { $in: apps.map((a) => a._id) } }).sort({ seq: 1 }).lean() : [];
  const by = new Map();
  for (const e of events) {
    const k = String(e.application);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(e);
  }
  return (app) => timeline.fold(by.get(String(app._id)) || [], app.status);
}

// ---------- candidate ----------
router.get("/applications/me", auth, role("student"), handle(async (req, res) => {
  if (!timeline.flagOn(req.userId, "student")) return ok(req, res, { enabled: false, applications: [] });
  const apps = await JobApplication.find({ userId: req.userId }).select("jobId userId status appliedAt").sort({ appliedAt: -1 }).limit(200).lean();
  const jobs = new Map((await Job.find({ _id: { $in: apps.map((a) => a.jobId) } }).select("title companyName postedBy isExternal archivedAt").lean()).map((j) => [String(j._id), j]));
  const stateOf = await statesFor(apps);
  const out = [];
  for (const a of apps) {
    const job = jobs.get(String(a.jobId));
    if (!timeline.enabledForJob(job, a.userId)) continue;
    const ctx = { role: "candidate", external: timeline.isExternalJob(job), archived: !!job?.archivedAt };
    const s = stateOf(a);
    out.push({
      applicationId: String(a._id),
      job: { id: String(a.jobId), title: job?.title || "", company: job?.companyName || "", archived: ctx.archived },
      external: ctx.external,
      externalLabel: ctx.external ? timeline.EXTERNAL_LABEL : null,
      appliedAt: a.appliedAt,
      stage: s.stage,
      closed: ["hired", "rejected", "withdrawn"].includes(s.stage),
      version: s.version,
      interview: s.interview,
      offer: s.offer,
      hire: s.hire,
      lastEventAt: s.lastEventAt || a.appliedAt,
      nextAllowedActions: timeline.nextAllowedActions(s, "candidate", ctx),
    });
  }
  ok(req, res, { enabled: true, applications: out });
}));

router.get("/applications/:id/timeline", auth, handle(async (req, res) => {
  const ctx = await timeline.contextFor(req.params.id, req.userId);
  const t = await timeline.timeline(ctx);
  ok(req, res, { ...t, interviewDetails: ctx.external ? null : await interviews.latestFor(ctx.app._id) });
}));

router.post("/applications/:id/events", auth, handle(async (req, res) => {
  const ctx = await timeline.contextFor(req.params.id, req.userId);
  const { type, version, note, internalNote } = req.body || {};
  if (!timeline.GENERIC_EVENTS.includes(type)) {
    return fail(req, res, 400, "NOT_A_GENERIC_EVENT", `Use the interview / offer routes for ${type || "this"}; allowed here: ${timeline.GENERIC_EVENTS.join(", ")}`);
  }
  const out = await timeline.append(ctx, {
    type,
    expectedVersion: version,
    idempotencyKey: idemKey(req),
    metadata: { note, ...(ctx.role === "candidate" ? {} : { internalNote }) },
    source: ctx.role === "candidate" ? "app" : "portal",
  });
  ok(req, res, out, out.duplicate ? 200 : 201);
}));

// ---------- employer ----------
router.get("/employers/me/applications", auth, role("employee", "admin"), handle(async (req, res) => {
  if (!timeline.flagOn(req.userId, "employee")) return ok(req, res, { enabled: false, jobs: [], applications: [] });
  const jobQuery = { postedBy: req.userId };
  if (req.query.jobId) {
    if (!isId(req.query.jobId)) return fail(req, res, 400, "INVALID_ID", "Invalid job id");
    jobQuery._id = req.query.jobId;
  }
  const jobs = await Job.find(jobQuery).select("title companyName postedBy isExternal archivedAt").lean();
  const apps = await JobApplication.find({ jobId: { $in: jobs.map((j) => j._id) } }).select("jobId userId status appliedAt fullName").sort({ appliedAt: -1 }).limit(1000).lean();
  const byJob = new Map(jobs.map((j) => [String(j._id), j]));
  const stateOf = await statesFor(apps);
  ok(req, res, {
    enabled: true,
    jobs: jobs.map((j) => ({ id: String(j._id), title: j.title, archived: !!j.archivedAt, external: !!j.isExternal })),
    applications: apps.map((a) => {
      const job = byJob.get(String(a.jobId));
      const careerEnabled = timeline.flagOn(a.userId, "student");
      const ctx = { role: "employer", external: !!job?.isExternal, archived: !!job?.archivedAt };
      const s = stateOf(a);
      return {
        applicationId: String(a._id),
        jobId: String(a.jobId),
        jobTitle: job?.title || "",
        candidateName: a.fullName || "",
        appliedAt: a.appliedAt,
        careerEnabled, // false: a candidate outside the pilot; the old screens handle them
        stage: s.stage,
        version: s.version,
        interview: s.interview,
        offer: s.offer,
        hire: s.hire,
        nextAllowedActions: careerEnabled ? timeline.nextAllowedActions(s, "employer", ctx) : [],
      };
    }),
  });
}));

// ---------- interviews ----------
const ivReply = (req, res) => (out) => ok(req, res, out, out.duplicate ? 200 : 201);

router.post("/interviews", auth, handle(async (req, res) => {
  const ctx = await timeline.contextFor(req.body?.applicationId, req.userId);
  ivReply(req, res)(await interviews.schedule(ctx, req.body || {}, idemKey(req)));
}));
router.post("/interviews/:id/reschedule", auth, handle(async (req, res) => ivReply(req, res)(await interviews.reschedule(req.params.id, req.userId, req.body || {}, idemKey(req)))));
router.post("/interviews/:id/cancel", auth, handle(async (req, res) => ivReply(req, res)(await interviews.cancel(req.params.id, req.userId, req.body || {}, idemKey(req)))));
router.post("/interviews/:id/respond", auth, handle(async (req, res) => ivReply(req, res)(await interviews.respond(req.params.id, req.userId, req.body || {}, idemKey(req)))));
router.post("/interviews/:id/complete", auth, handle(async (req, res) => ivReply(req, res)(await interviews.complete(req.params.id, req.userId, req.body || {}, idemKey(req)))));

router.get("/interviews/:id", auth, handle(async (req, res) => {
  const { iv } = await interviews.load(req.params.id, req.userId);
  ok(req, res, interviews.view(iv));
}));

// the calendar file (Add to calendar); the same UID every time, a higher SEQUENCE after each change
router.get("/interviews/:id/ics", auth, handle(async (req, res) => {
  const { iv, ctx } = await interviews.load(req.params.id, req.userId);
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="interview-${iv._id}.ics"`);
  res.set("Cache-Control", "private, no-store");
  res.send(interviews.ics(iv, { jobTitle: ctx.job?.title, company: ctx.job?.companyName }));
}));

module.exports = router;

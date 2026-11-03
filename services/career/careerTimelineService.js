// services/career/careerTimelineService.js
// The hiring timeline of one JobApplication: an append-only event log (models/CareerApplicationEvent),
// folded into one server-side state that the candidate app and the employer portal both read.
//
// - Every write: authenticated role, job ownership (employer: only their own jobs), candidate: only their
//   own application, an allowed transition for that role from the current state, the version the caller
//   last saw (optimistic check: the unique (application, seq) index), an idempotency key (a retry
//   returns the event already written).
// - Compatibility adapter (approved): the stage is projected onto the existing JobApplication.status so
//   old screens stay consistent; "hired" only on a verified hire. Mapping: docs/CAREER_TIMELINE.md.
// - Behind FLAG_CAREER_TIMELINE, on for BOTH the employer and the candidate.
// - External / imported jobs: "External application, outcome unverified"; no interview or hire claims.
const mongoose = require("mongoose");
const CareerApplicationEvent = require("../../models/CareerApplicationEvent");
const JobApplication = require("../../models/JobApplication");
const Job = require("../../models/Job");
const User = require("../../models/User");
const { isEnabled } = require("../../config/featureFlags");
const { withTransaction } = require("../../utils/transaction");
const { recordSafe } = require("../domainEvents");

const DAY = 24 * 60 * 60 * 1000;
const DISPUTE_DAYS = 7;
const EXTERNAL_LABEL = "External application, outcome unverified";

class CareerError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => a != null && b != null && String(a) === String(b);

// ---------- stages and the legacy projection ----------
const STAGES = ["applied", "reviewed", "shortlisted", "interview", "offer", "hired", "rejected", "withdrawn"];
// stage → existing JobApplication.status (its enum: pending reviewed shortlisted interview rejected hired)
const LEGACY_STATUS = { applied: "pending", reviewed: "reviewed", shortlisted: "shortlisted", interview: "interview", offer: "interview", hired: "hired", rejected: "rejected", withdrawn: "rejected" };
// existing JobApplication.status → stage (applications that have no timeline yet)
const STAGE_OF_LEGACY = { pending: "applied", reviewed: "reviewed", shortlisted: "shortlisted", interview: "interview", rejected: "rejected", hired: "hired" };
const CLOSED = new Set(["hired", "rejected", "withdrawn"]);
const ACTIVE_INTERVIEW = new Set(["invited", "accepted", "reschedule_requested"]);
const OPEN_OFFER = new Set(["none", "declined", "expired", "withdrawn"]);

// ---------- the state, folded from the events ----------
function fold(events, legacyStatus = "pending", now = new Date()) {
  const s = {
    stage: events.length ? "applied" : STAGE_OF_LEGACY[legacyStatus] || "applied",
    version: 0,
    interview: { id: null, status: "none", startsAt: null },
    offer: { id: null, status: "none", expiresAt: null },
    hire: { status: "none", confirmedAt: null, disputeWindowEndsAt: null },
    interviewCompletedAt: null,
    legacyHired: false,
    lastEventAt: null,
  };
  for (const e of events) {
    s.version = e.seq;
    s.lastEventAt = e.occurredAt;
    const m = e.metadata || {};
    switch (e.type) {
      case "APPLIED": s.stage = "applied"; break;
      case "LEGACY_STATUS": s.stage = STAGE_OF_LEGACY[m.legacyStatus] || s.stage; s.legacyHired = m.legacyStatus === "hired"; break;
      case "REVIEWED": s.stage = "reviewed"; break;
      case "SHORTLISTED": s.stage = "shortlisted"; break;
      case "REJECTED": s.stage = "rejected"; break;
      case "WITHDRAWN": s.stage = "withdrawn"; break;
      case "INTERVIEW_INVITED": s.stage = "interview"; s.interview = { id: m.interviewId, status: "invited", startsAt: m.startsAt }; break;
      case "INTERVIEW_RESCHEDULED": s.interview = { id: m.interviewId, status: "invited", startsAt: m.startsAt }; break;
      case "INTERVIEW_ACCEPTED": s.interview.status = "accepted"; break;
      case "INTERVIEW_DECLINED": s.interview.status = "declined"; break;
      case "INTERVIEW_RESCHEDULE_REQUESTED": s.interview.status = "reschedule_requested"; break;
      case "INTERVIEW_CANCELLED": s.interview.status = "cancelled"; break;
      case "INTERVIEW_COMPLETED": s.interview.status = "completed"; s.interviewCompletedAt = e.occurredAt; break;
      case "CANDIDATE_NO_SHOW_REPORTED": s.interview.status = "candidate_no_show_reported"; break;
      case "EMPLOYER_NO_SHOW_REPORTED": s.interview.status = "employer_no_show_reported"; break;
      case "INTERVIEW_DISPUTED": s.interview.status = "disputed"; break;
      case "OFFER_SENT": s.stage = "offer"; s.offer = { id: m.offerId, status: "sent", expiresAt: m.expiresAt || null }; break;
      case "OFFER_ACCEPTED": s.offer.status = "accepted"; break;
      case "OFFER_DECLINED": s.offer.status = "declined"; break;
      case "OFFER_WITHDRAWN": s.offer.status = "withdrawn"; break;
      case "OFFER_EXPIRED": s.offer.status = "expired"; break;
      case "HIRE_CONFIRMED": s.stage = "hired"; s.hire = { status: "verified", confirmedAt: e.occurredAt, disputeWindowEndsAt: new Date(new Date(e.occurredAt).getTime() + DISPUTE_DAYS * DAY) }; break;
      case "HIRE_DISPUTED":
      case "HIRE_REVOKED": s.stage = "offer"; s.hire = { ...s.hire, status: "revoked" }; break;
      default: break;
    }
  }
  // an offer past its deadline with no answer is expired, even before anyone writes OFFER_EXPIRED
  if (s.offer.status === "sent" && s.offer.expiresAt && new Date(s.offer.expiresAt) < now) s.offer.status = "expired";
  return s;
}

// ---------- who may do what, from which state ----------
const notClosed = (s) => !CLOSED.has(s.stage);
const started = (s, now) => !!s.interview.startsAt && new Date(s.interview.startsAt) <= now;
const RULES = {
  REVIEWED: { roles: ["employer"], ok: (s) => s.stage === "applied" },
  SHORTLISTED: { roles: ["employer"], ok: (s) => ["applied", "reviewed"].includes(s.stage) },
  REJECTED: { roles: ["employer"], ok: (s) => notClosed(s) && s.offer.status !== "accepted" },
  WITHDRAWN: { roles: ["candidate"], ok: (s) => notClosed(s) },
  INTERVIEW_INVITED: { roles: ["employer"], ok: (s) => ["reviewed", "shortlisted", "interview"].includes(s.stage) && !ACTIVE_INTERVIEW.has(s.interview.status), internal: true },
  INTERVIEW_RESCHEDULED: { roles: ["employer"], ok: (s) => s.stage === "interview" && ACTIVE_INTERVIEW.has(s.interview.status), internal: true },
  INTERVIEW_CANCELLED: { roles: ["employer"], ok: (s) => s.stage === "interview" && ACTIVE_INTERVIEW.has(s.interview.status), internal: true },
  INTERVIEW_ACCEPTED: { roles: ["candidate"], ok: (s) => s.stage === "interview" && s.interview.status === "invited", internal: true },
  INTERVIEW_DECLINED: { roles: ["candidate"], ok: (s) => s.stage === "interview" && ["invited", "accepted"].includes(s.interview.status), internal: true },
  INTERVIEW_RESCHEDULE_REQUESTED: { roles: ["candidate"], ok: (s) => s.stage === "interview" && ["invited", "accepted"].includes(s.interview.status), internal: true },
  // completed needs the candidate's acceptance and the slot to have started; the employer records it
  INTERVIEW_COMPLETED: { roles: ["employer"], ok: (s, now) => s.stage === "interview" && s.interview.status === "accepted" && started(s, now), internal: true },
  CANDIDATE_NO_SHOW_REPORTED: { roles: ["employer"], ok: (s, now) => s.stage === "interview" && s.interview.status === "accepted" && started(s, now), internal: true },
  EMPLOYER_NO_SHOW_REPORTED: { roles: ["candidate"], ok: (s, now) => s.stage === "interview" && s.interview.status === "accepted" && started(s, now) },
  // the candidate disputes a recorded completion or a no-show report (never auto-penalised)
  INTERVIEW_DISPUTED: { roles: ["candidate"], ok: (s) => ["completed", "candidate_no_show_reported"].includes(s.interview.status) && s.stage !== "withdrawn" },
  OFFER_SENT: { roles: ["employer"], ok: (s) => ["shortlisted", "interview", "offer"].includes(s.stage) && OPEN_OFFER.has(s.offer.status), internal: true },
  OFFER_WITHDRAWN: { roles: ["employer"], ok: (s) => s.stage === "offer" && s.offer.status === "sent", internal: true },
  OFFER_ACCEPTED: { roles: ["candidate"], ok: (s) => s.stage === "offer" && s.offer.status === "sent", internal: true },
  OFFER_DECLINED: { roles: ["candidate"], ok: (s) => s.stage === "offer" && s.offer.status === "sent", internal: true },
  // a verified hire: the candidate accepted the offer AND the employer confirms
  HIRE_CONFIRMED: { roles: ["employer"], ok: (s) => s.stage === "offer" && s.offer.status === "accepted" && s.hire.status !== "verified", internal: true },
  HIRE_DISPUTED: { roles: ["candidate"], ok: (s, now) => s.hire.status === "verified" && now <= new Date(s.hire.disputeWindowEndsAt) },
  HIRE_REVOKED: { roles: ["admin"], ok: (s) => s.hire.status === "verified" },
};
// events the generic POST /applications/:id/events accepts; the rest go through the interview / offer routes
const GENERIC_EVENTS = Object.keys(RULES).filter((t) => !RULES[t].internal);
// events that need an internal job (an external application has no interview or hire on TDC)
const INTERNAL_ONLY = new Set(Object.keys(RULES).filter((t) => t.startsWith("INTERVIEW_") || t.startsWith("OFFER_") || t.startsWith("HIRE_") || t.endsWith("_NO_SHOW_REPORTED")));

// on a deleted (archived) job the employer can still close out what's under way, but start nothing new
const ARCHIVED_EMPLOYER_OK = new Set(["REJECTED", "HIRE_CONFIRMED", "INTERVIEW_CANCELLED", "OFFER_WITHDRAWN", "INTERVIEW_COMPLETED", "CANDIDATE_NO_SHOW_REPORTED"]);
const blockedOnArchived = (ctx, type) => !!ctx?.archived && RULES[type].roles.includes("employer") && !ARCHIVED_EMPLOYER_OK.has(type);

function nextAllowedActions(state, role, ctx, now = new Date()) {
  if (ctx?.external) return role === "candidate" && notClosed(state) ? ["WITHDRAWN"] : [];
  const roles = role === "admin" ? ["admin", "employer"] : [role];
  return Object.keys(RULES).filter((t) => RULES[t].roles.some((r) => roles.includes(r)) && RULES[t].ok(state, now) && !blockedOnArchived(ctx, t));
}

// ---------- access ----------
const flagOn = (id, role) => !!id && isEnabled("careerTimeline", { id: String(id), role });
const enabledFor = (employerId, candidateId) => flagOn(employerId, "employee") && flagOn(candidateId, "student");
// an external / imported job has no employer on TDC: only the candidate's flag counts
const isExternalJob = (job) => !job || !!job.isExternal || !job.postedBy;
const enabledForJob = (job, candidateId) => (isExternalJob(job) ? flagOn(candidateId, "student") : enabledFor(job.postedBy, candidateId));

// The application and the caller's role on it. Throws 404 for anything the caller may not see.
async function contextFor(applicationId, userId) {
  if (!isId(applicationId)) throw new CareerError(400, "INVALID_ID", "Invalid application id");
  if (!isId(userId)) throw new CareerError(401, "SIGN_IN", "Sign in first");
  const [app, user] = await Promise.all([
    JobApplication.findById(applicationId).select("jobId userId status appliedAt").lean(),
    User.findById(userId).select("role").lean(),
  ]);
  if (!app || !user) throw new CareerError(404, "NOT_FOUND", "Application not found");
  const job = await Job.findById(app.jobId).select("title companyName postedBy isExternal archivedAt active").lean();
  const employerId = job?.postedBy || null;
  let role = null;
  if (user.role === "admin") role = "admin";
  else if (same(app.userId, userId)) role = "candidate";
  else if (["employee", "admin"].includes(user.role) && same(employerId, userId)) role = "employer";
  // not the candidate, not this job's employer: it doesn't exist for them
  if (!role) throw new CareerError(404, "NOT_FOUND", "Application not found");
  if (!enabledForJob(job, app.userId)) throw new CareerError(404, "CAREER_OFF", "The hiring timeline is not available for this application");
  return {
    app,
    job,
    role,
    userId: String(userId),
    candidateId: String(app.userId),
    employerId: employerId ? String(employerId) : null,
    external: isExternalJob(job),
    archived: !!job?.archivedAt,
  };
}

const eventsOf = (applicationId, session = null) => CareerApplicationEvent.find({ application: applicationId }).sort({ seq: 1 }).session(session).lean();

async function stateOf(ctx, now = new Date()) {
  const events = await eventsOf(ctx.app._id);
  return { events, state: fold(events, ctx.app.status, now) };
}

// ---------- after-commit listeners (notifications subscribe here) ----------
const listeners = [];
const onEvent = (fn) => listeners.push(fn);
async function emit(event, ctx) {
  for (const fn of listeners) {
    try { await fn(event, ctx); } catch (err) { console.error(`[career] listener for ${event.type} failed: ${err.message}`); }
  }
}

// ---------- writing ----------
const baseRow = (ctx) => ({ application: ctx.app._id, job: ctx.app.jobId, candidate: ctx.candidateId, employer: ctx.employerId });

// an application that has no events yet gets its start written once (applied, and its current legacy
// status), so its history begins where the old screens left it; concurrent callers collapse
async function ensureStarted(ctx, session = null) {
  const n = await CareerApplicationEvent.countDocuments({ application: ctx.app._id }).session(session);
  if (n > 0) return;
  const rows = [{ ...baseRow(ctx), seq: 1, type: "APPLIED", actorRole: "system", source: "legacy", idempotencyKey: `${ctx.app._id}:start:applied`, occurredAt: ctx.app.appliedAt || new Date() }];
  if (ctx.app.status && ctx.app.status !== "pending") {
    rows.push({ ...baseRow(ctx), seq: 2, type: "LEGACY_STATUS", actorRole: "system", source: "legacy", metadata: { legacyStatus: ctx.app.status }, idempotencyKey: `${ctx.app._id}:start:legacy`, occurredAt: new Date() });
  }
  for (const r of rows) {
    try {
      await CareerApplicationEvent.create([r], { session });
    } catch (err) {
      if (err?.code !== 11000) throw err; // someone else started it at the same moment
    }
  }
}

/**
 * Append one event.
 *   ctx: contextFor(); type: an event type in RULES; expectedVersion: the version the caller saw
 *   (0 = an application they saw without a timeline); idempotencyKey: the caller's key (optional);
 *   metadata: { note, internalNote, ... }; sideEffect(session, event): writes that belong to this event
 *   (an interview / offer document), in the same transaction.
 */
async function append(ctx, { type, expectedVersion, idempotencyKey = null, metadata = {}, source = "", actorRole = null, sideEffect = null, now = new Date() }) {
  const rule = RULES[type];
  if (!rule) throw new CareerError(400, "UNKNOWN_EVENT", `Unknown event ${type}`);
  const role = actorRole || ctx.role;
  const acting = role === "admin" && !rule.roles.includes("admin") && rule.roles.includes("employer") ? "employer" : role;
  if (!rule.roles.includes(acting)) throw new CareerError(403, "NOT_YOUR_ACTION", `${type} is not an action for a ${role}`);
  if (ctx.external && INTERNAL_ONLY.has(type)) throw new CareerError(409, "EXTERNAL_JOB", `${EXTERNAL_LABEL}: interviews, offers and hires aren't tracked for it`);
  if (blockedOnArchived(ctx, type)) {
    throw new CareerError(410, "JOB_ARCHIVED", "This job was deleted; its history stays, but nothing new can start");
  }
  if (expectedVersion == null || !Number.isInteger(Number(expectedVersion))) throw new CareerError(400, "VERSION_REQUIRED", "Send the version you last saw");
  const fullKey = idempotencyKey ? `${ctx.app._id}:${String(idempotencyKey).slice(0, 100)}` : null;
  if (fullKey) {
    const done = await CareerApplicationEvent.findOne({ idempotencyKey: fullKey }).lean();
    if (done) return { duplicate: true, ...(await reply(ctx, done)) };
  }

  let events = await eventsOf(ctx.app._id);
  let expected = Number(expectedVersion);
  if (!events.length) {
    // the caller saw the application before its timeline existed (version 0)
    if (expected !== 0) throw new CareerError(409, "VERSION_CONFLICT", "The application changed meanwhile; reload it", { currentVersion: 0 });
    await ensureStarted(ctx);
    events = await eventsOf(ctx.app._id);
    expected = events.length ? events[events.length - 1].seq : 0;
  }
  const state = fold(events, ctx.app.status, now);
  if (expected !== state.version) throw new CareerError(409, "VERSION_CONFLICT", "The application changed meanwhile; reload it", { currentVersion: state.version });
  if (!rule.ok(state, now)) {
    throw new CareerError(409, "INVALID_TRANSITION", `${type} is not possible now (stage ${state.stage})`, { stage: state.stage, nextAllowedActions: nextAllowedActions(state, ctx.role, ctx, now) });
  }

  const row = {
    ...baseRow(ctx),
    seq: state.version + 1,
    type,
    actor: ctx.userId,
    actorRole: role,
    source: String(source || ""),
    metadata: {
      ...(metadata.note ? { note: String(metadata.note).slice(0, 1000) } : {}),
      ...(metadata.internalNote ? { internalNote: String(metadata.internalNote).slice(0, 1000) } : {}),
      ...Object.fromEntries(Object.entries(metadata).filter(([k]) => !["note", "internalNote"].includes(k))),
    },
    idempotencyKey: fullKey || `${ctx.app._id}:v${state.version + 1}:${type}`,
    occurredAt: now,
  };
  let event;
  try {
    ({ result: event } = await withTransaction(async (session) => {
      const [e] = await CareerApplicationEvent.create([row], { session });
      const ev = e.toObject();
      if (sideEffect) await sideEffect(session, ev);
      // compatibility adapter: the existing status follows the stage ("hired" only on a verified hire)
      const after = fold([...events, ev], ctx.app.status, now);
      const legacy = LEGACY_STATUS[after.stage];
      if (legacy && legacy !== ctx.app.status && !(after.stage === "hired" && after.hire.status !== "verified")) {
        await JobApplication.updateOne({ _id: ctx.app._id }, { $set: { status: legacy, lastUpdated: now } }, { session });
        ctx.app.status = legacy;
      }
      return ev;
    }));
  } catch (err) {
    if (err?.code === 11000) {
      const done = fullKey && (await CareerApplicationEvent.findOne({ idempotencyKey: fullKey }).lean());
      if (done) return { duplicate: true, ...(await reply(ctx, done)) };
      throw new CareerError(409, "VERSION_CONFLICT", "The application changed meanwhile; reload it");
    }
    throw err;
  }
  if (ctx.role === "admin") await auditAdmin(ctx, `write:${type}`);
  await emit(event, ctx);
  return reply(ctx, event);
}

async function reply(ctx, event) {
  const { state } = await stateOf(ctx);
  return {
    applicationId: String(ctx.app._id),
    state: state.stage,
    version: state.version,
    eventId: String(event._id),
    type: event.type,
    occurredAt: event.occurredAt,
    nextAllowedActions: nextAllowedActions(state, ctx.role, ctx),
  };
}

// "system" APPLIED for a new application (the apply route), no version needed
async function recordApplied({ applicationId, source = "app" }) {
  const app = await JobApplication.findById(applicationId).select("jobId userId status appliedAt").lean();
  if (!app) return null;
  const job = await Job.findById(app.jobId).select("postedBy isExternal").lean();
  if (!enabledForJob(job, app.userId)) return null;
  const row = { application: app._id, job: app.jobId, candidate: app.userId, employer: job?.postedBy || null, seq: 1, type: "APPLIED", actor: app.userId, actorRole: "system", source, idempotencyKey: `${app._id}:start:applied`, occurredAt: app.appliedAt || new Date() };
  try {
    const [e] = await CareerApplicationEvent.create([row]);
    return e.toObject();
  } catch (err) {
    if (err?.code === 11000) return null; // already started (a retried apply)
    throw err;
  }
}

// ---------- reading ----------
const PUBLIC_META = ["note", "interviewId", "offerId", "startsAt", "endsAt", "timezone", "mode", "location", "meetingLink", "expiresAt", "response", "outcome", "reason", "legacyStatus", "previousStartsAt"];
function viewEvent(e, role) {
  const m = e.metadata || {};
  const meta = Object.fromEntries(Object.entries(m).filter(([k]) => PUBLIC_META.includes(k) || (k === "internalNote" && role !== "candidate")));
  return { id: String(e._id), seq: e.seq, type: e.type, actorRole: e.actorRole, source: e.source, occurredAt: e.occurredAt, metadata: meta };
}

async function timeline(ctx, now = new Date()) {
  const { events, state } = await stateOf(ctx, now);
  if (ctx.role === "admin") await auditAdmin(ctx, "read:timeline");
  return {
    applicationId: String(ctx.app._id),
    job: { id: String(ctx.app.jobId), title: ctx.job?.title || "", company: ctx.job?.companyName || "", archived: ctx.archived },
    external: ctx.external,
    externalLabel: ctx.external ? EXTERNAL_LABEL : null,
    stage: state.stage,
    legacyStatus: ctx.app.status,
    version: state.version,
    interview: state.interview,
    offer: state.offer,
    hire: state.hire,
    nextAllowedActions: nextAllowedActions(state, ctx.role, ctx, now),
    events: events.map((e) => viewEvent(e, ctx.role)),
  };
}

// admin reads and writes are recorded (who looked at which application, and when)
async function auditAdmin(ctx, action) {
  await recordSafe("career.admin.access", `${ctx.userId}:${ctx.app._id}:${action}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, {
    actor: ctx.userId, subject: { kind: "JobApplication", id: ctx.app._id }, data: { action },
  });
}

module.exports = {
  CareerError,
  STAGES,
  LEGACY_STATUS,
  STAGE_OF_LEGACY,
  RULES,
  GENERIC_EVENTS,
  EXTERNAL_LABEL,
  DISPUTE_DAYS,
  fold,
  nextAllowedActions,
  enabledFor,
  enabledForJob,
  isExternalJob,
  flagOn,
  contextFor,
  stateOf,
  eventsOf,
  append,
  recordApplied,
  timeline,
  viewEvent,
  onEvent,
  auditAdmin,
  isId,
};

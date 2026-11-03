// services/career/careerInterviewService.js
// Interviews on the hiring timeline: the employer schedules, reschedules, cancels and records the outcome;
// the candidate accepts, declines, asks for another time, reports an employer no-show or disputes a
// recorded outcome. Each action is one timeline event (careerTimelineService.append: role, ownership,
// version, idempotency) and updates the CareerInterview in the same transaction.
//   - scheduled != completed: "completed" needs the candidate's acceptance, a slot that has started, and
//     the employer recording it; the candidate can dispute it.
//   - no-show reports are reports only: nothing is penalised automatically.
//   - .ics: a stable UID per interview, SEQUENCE bumped on every reschedule / cancellation.
const mongoose = require("mongoose");
const CareerInterview = require("../../models/CareerInterview");
const JobApplication = require("../../models/JobApplication");
const timeline = require("./careerTimelineService");

const { CareerError } = timeline;
const MIN = 60 * 1000;
const MODES = ["online", "in-person", "phone"];

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// the slot fields of a schedule / reschedule request
function slotOf(body, now) {
  const startsAt = new Date(body.startsAt);
  if (!body.startsAt || Number.isNaN(startsAt.getTime())) throw new CareerError(400, "INVALID_TIME", "startsAt must be a date and time");
  if (startsAt.getTime() < now.getTime() + 5 * MIN) throw new CareerError(400, "INVALID_TIME", "The interview must start in the future");
  const minutes = Number(body.durationMinutes ?? 45);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 480) throw new CareerError(400, "INVALID_DURATION", "durationMinutes must be 10 to 480");
  const timezone = String(body.timezone || "Asia/Karachi");
  if (!validTimezone(timezone)) throw new CareerError(400, "INVALID_TIMEZONE", "Unknown time zone");
  const mode = String(body.mode || "online");
  if (!MODES.includes(mode)) throw new CareerError(400, "INVALID_MODE", `mode: ${MODES.join(", ")}`);
  const meetingLink = String(body.meetingLink || "").trim();
  if (meetingLink && !/^https:\/\/[^\s]+$/i.test(meetingLink)) throw new CareerError(400, "INVALID_LINK", "The meeting link must be an https:// address");
  if (mode === "online" && !meetingLink) throw new CareerError(400, "LINK_REQUIRED", "An online interview needs a meeting link");
  const location = String(body.location || "").trim().slice(0, 300);
  if (mode === "in-person" && !location) throw new CareerError(400, "LOCATION_REQUIRED", "An in-person interview needs a location");
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * MIN), timezone, mode, meetingLink, location, note: String(body.note || "").slice(0, 1000) };
}

// no double booking: another active interview of the same employer or candidate overlapping the slot
async function assertNoConflict(ctx, slot, exceptId = null) {
  const overlap = { active: true, startsAt: { $lt: slot.endsAt }, endsAt: { $gt: slot.startsAt } };
  if (exceptId) overlap._id = { $ne: exceptId };
  const clash = await CareerInterview.findOne({ ...overlap, $or: [{ employer: ctx.employerId }, { candidate: ctx.candidateId }] }).lean();
  if (clash) {
    throw new CareerError(409, "SLOT_CONFLICT", same(clash.employer, ctx.employerId) ? "You already have an interview at that time" : "The candidate already has an interview at that time", { conflictStartsAt: clash.startsAt, conflictEndsAt: clash.endsAt });
  }
}
const same = (a, b) => String(a) === String(b);

// the existing JobApplication fields old screens read (no schema change)
const legacyFields = (slot) => ({ interviewDate: slot.startsAt, interviewNotes: slot.note || "" });

async function load(interviewId, userId) {
  if (!timeline.isId(interviewId)) throw new CareerError(400, "INVALID_ID", "Invalid interview id");
  const iv = await CareerInterview.findById(interviewId).lean();
  if (!iv) throw new CareerError(404, "NOT_FOUND", "Interview not found");
  const ctx = await timeline.contextFor(iv.application, userId); // 404 for anyone else
  return { iv, ctx };
}

async function schedule(ctx, body, idempotencyKey, now = new Date()) {
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the employer schedules interviews");
  const slot = slotOf(body, now);
  await assertNoConflict(ctx, slot);
  const interviewId = new mongoose.Types.ObjectId();
  return timeline.append(ctx, {
    type: "INTERVIEW_INVITED",
    expectedVersion: body.version,
    idempotencyKey,
    source: "portal",
    metadata: { interviewId: String(interviewId), startsAt: slot.startsAt, endsAt: slot.endsAt, timezone: slot.timezone, mode: slot.mode, location: slot.location, meetingLink: slot.meetingLink, note: slot.note },
    now,
    sideEffect: async (session) => {
      await CareerInterview.create([{
        _id: interviewId, application: ctx.app._id, job: ctx.app.jobId, employer: ctx.employerId, candidate: ctx.candidateId,
        ...slot, status: "invited", active: true, calendarUid: `career-interview-${interviewId}`, calendarSequence: 0,
      }], { session });
      await JobApplication.updateOne({ _id: ctx.app._id }, { $set: legacyFields(slot) }, { session });
    },
  });
}

async function reschedule(interviewId, userId, body, idempotencyKey, now = new Date()) {
  const { iv, ctx } = await load(interviewId, userId);
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the employer moves an interview; ask for another time instead");
  if (!iv.active) throw new CareerError(409, "INTERVIEW_CLOSED", "This interview is no longer active");
  const slot = slotOf(body, now);
  await assertNoConflict(ctx, slot, iv._id);
  return timeline.append(ctx, {
    type: "INTERVIEW_RESCHEDULED",
    expectedVersion: body.version,
    idempotencyKey,
    source: "portal",
    metadata: { interviewId: String(iv._id), startsAt: slot.startsAt, endsAt: slot.endsAt, previousStartsAt: iv.startsAt, timezone: slot.timezone, mode: slot.mode, location: slot.location, meetingLink: slot.meetingLink, note: slot.note },
    now,
    sideEffect: async (session) => {
      await CareerInterview.updateOne(
        { _id: iv._id },
        { $set: { ...slot, status: "invited" }, $inc: { calendarSequence: 1 }, $push: { history: { startsAt: iv.startsAt, endsAt: iv.endsAt, changedAt: now } } },
        { session }
      );
      await JobApplication.updateOne({ _id: ctx.app._id }, { $set: legacyFields(slot) }, { session });
    },
  });
}

async function cancel(interviewId, userId, body, idempotencyKey, now = new Date()) {
  const { iv, ctx } = await load(interviewId, userId);
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Decline the interview instead");
  return timeline.append(ctx, {
    type: "INTERVIEW_CANCELLED",
    expectedVersion: body.version,
    idempotencyKey,
    source: "portal",
    metadata: { interviewId: String(iv._id), note: body.note },
    now,
    sideEffect: (session) => CareerInterview.updateOne({ _id: iv._id }, { $set: { status: "cancelled", active: false }, $inc: { calendarSequence: 1 } }, { session }),
  });
}

// candidate: accept | decline | reschedule (ask for another time) | employer_no_show | dispute
const CANDIDATE_RESPONSES = {
  accept: { type: "INTERVIEW_ACCEPTED", status: "accepted", active: true },
  decline: { type: "INTERVIEW_DECLINED", status: "declined", active: false },
  reschedule: { type: "INTERVIEW_RESCHEDULE_REQUESTED", status: "reschedule_requested", active: true },
  employer_no_show: { type: "EMPLOYER_NO_SHOW_REPORTED", status: "employer_no_show_reported", active: false },
  dispute: { type: "INTERVIEW_DISPUTED", status: "disputed", active: false },
};
async function respond(interviewId, userId, body, idempotencyKey, now = new Date()) {
  const { iv, ctx } = await load(interviewId, userId);
  if (ctx.role !== "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the candidate responds to an interview");
  const r = CANDIDATE_RESPONSES[body.response];
  if (!r) throw new CareerError(400, "INVALID_RESPONSE", `response: ${Object.keys(CANDIDATE_RESPONSES).join(", ")}`);
  const message = String(body.message || "").slice(0, 500);
  if (body.response === "dispute" && message.trim().length < 5) throw new CareerError(400, "REASON_REQUIRED", "Say what's wrong (at least 5 characters)");
  return timeline.append(ctx, {
    type: r.type,
    expectedVersion: body.version,
    idempotencyKey,
    source: "app",
    metadata: { interviewId: String(iv._id), response: body.response, note: message },
    now,
    sideEffect: (session) => CareerInterview.updateOne({ _id: iv._id }, { $set: { status: r.status, active: r.active }, $push: { responses: { response: body.response, message, at: now } } }, { session }),
  });
}

// employer: completed | candidate_no_show (a report, never an automatic penalty)
async function complete(interviewId, userId, body, idempotencyKey, now = new Date()) {
  const { iv, ctx } = await load(interviewId, userId);
  if (ctx.role === "candidate") throw new CareerError(403, "NOT_YOUR_ACTION", "Only the employer records the interview outcome");
  const outcome = body.outcome || "completed";
  if (!["completed", "candidate_no_show"].includes(outcome)) throw new CareerError(400, "INVALID_OUTCOME", "outcome: completed or candidate_no_show");
  return timeline.append(ctx, {
    type: outcome === "completed" ? "INTERVIEW_COMPLETED" : "CANDIDATE_NO_SHOW_REPORTED",
    expectedVersion: body.version,
    idempotencyKey,
    source: "portal",
    metadata: { interviewId: String(iv._id), outcome, note: body.note, internalNote: body.internalNote },
    now,
    sideEffect: (session) => CareerInterview.updateOne({ _id: iv._id }, { $set: { status: outcome === "completed" ? "completed" : "candidate_no_show_reported", active: false, completedAt: now } }, { session }),
  });
}

// a withdrawn or rejected application: its pending interview is cancelled (no extra timeline event)
timeline.onEvent(async (event) => {
  if (!["WITHDRAWN", "REJECTED"].includes(event.type)) return;
  await CareerInterview.updateMany({ application: event.application, active: true }, { $set: { status: "cancelled", active: false }, $inc: { calendarSequence: 1 } });
});

// ---------- views ----------
function view(iv) {
  return {
    id: String(iv._id),
    applicationId: String(iv.application),
    status: iv.status,
    startsAt: iv.startsAt,
    endsAt: iv.endsAt,
    timezone: iv.timezone,
    mode: iv.mode,
    location: iv.location,
    meetingLink: iv.meetingLink,
    note: iv.note,
    calendarSequence: iv.calendarSequence,
    history: (iv.history || []).map((h) => ({ startsAt: h.startsAt, endsAt: h.endsAt, changedAt: h.changedAt })),
    icsUrl: `/api/career/interviews/${iv._id}/ics`,
  };
}
const latestFor = async (applicationId) => {
  const iv = await CareerInterview.findOne({ application: applicationId }).sort({ createdAt: -1 }).lean();
  return iv ? view(iv) : null;
};

// ---------- .ics (RFC 5545) ----------
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// lines longer than 75 octets continue on the next line, starting with a space
function fold(line) {
  const out = [];
  let rest = Buffer.from(line, "utf8");
  while (rest.length > 75) {
    let cut = 75;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 character
    out.push(rest.slice(0, cut).toString("utf8"));
    rest = Buffer.concat([Buffer.from(" "), rest.slice(cut)]);
  }
  out.push(rest.toString("utf8"));
  return out.join("\r\n");
}
function ics(iv, { jobTitle = "", company = "" } = {}, now = new Date()) {
  const cancelled = ["cancelled", "declined"].includes(iv.status);
  const where = iv.mode === "online" ? iv.meetingLink : iv.mode === "in-person" ? iv.location : "Phone";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Deft Crew//Career interviews//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${iv.calendarUid}@thedeftcrew.com`,
    `SEQUENCE:${iv.calendarSequence || 0}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(iv.startsAt)}`,
    `DTEND:${icsDate(iv.endsAt)}`,
    `SUMMARY:${icsText(`Interview: ${jobTitle}${company ? ` at ${company}` : ""}`)}`,
    `LOCATION:${icsText(where)}`,
    `DESCRIPTION:${icsText([iv.note, iv.meetingLink && `Join: ${iv.meetingLink}`, `Time zone: ${iv.timezone}`].filter(Boolean).join("\n"))}`,
    ...(iv.meetingLink ? [`URL:${iv.meetingLink}`] : []),
    `STATUS:${cancelled ? "CANCELLED" : iv.status === "accepted" ? "CONFIRMED" : "TENTATIVE"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

module.exports = { schedule, reschedule, cancel, respond, complete, load, view, latestFor, ics, CANDIDATE_RESPONSES };

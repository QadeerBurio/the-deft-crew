// services/career/ratingService.js
// Mutual ratings (FLAG_CAREER_RATINGS) after an interview recorded as completed, and again after a verified hire.
//   - Each side rates the other once per event, within 14 days of it: 1-5 on three fixed questions, plus an
//     optional comment (300 characters, no profanity).
//   - Private by default. A rating reaches the person rated only once released: when both sides have rated
//     that event, or when its window has closed (so nobody rates in reaction to what they received).
//   - Students see an employer's average only from 5 released ratings, rounded to half a star, never comments.
//     The employer sees the same average. A student's ratings are never shown to any employer; the student
//     sees their own.
//   - No automatic penalties: ratings change nothing else (applications, matching, visibility).
//   - The person rated can report a rating as unfair; an admin hides it or keeps it, with a reason (audited).
// Eligibility is read from the hiring timeline (CareerApplicationEvent): an interview that was disputed after
// being recorded as completed can't be rated, and a hire must still be verified.
const mongoose = require("mongoose");
const User = require("../../models/User");
const Job = require("../../models/Job");
const JobApplication = require("../../models/JobApplication");
const CareerRating = require("../../models/CareerRating");
const CareerRatingReport = require("../../models/CareerRatingReport");
const timeline = require("./careerTimelineService");
const { isEnabled } = require("../../config/featureFlags");
const { recordSafe } = require("../domainEvents");
const { findProfanity } = require("../../utils/profanity");

const DAY = 864e5;
const WINDOW_DAYS = 14;
const MIN_PUBLIC = 5;
const QUESTIONS = {
  // what the employer answers about the candidate
  employer: [
    { id: "communication", label: "Communication" },
    { id: "punctuality", label: "Punctuality" },
    { id: "preparation", label: "Preparation" },
  ],
  // what the candidate answers about the employer
  candidate: [
    { id: "communication", label: "Communication" },
    { id: "respect", label: "Respect" },
    { id: "clarity", label: "Clarity of the process" },
  ],
};

class RatingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => a != null && b != null && String(a) === String(b);
const flagOn = (id, role) => !!id && isEnabled("careerRatings", { id: String(id), role });
const released = (r, now = new Date()) => !!r.releasedAt || new Date(r.windowEndsAt) <= now;
const halfStar = (x) => Math.round(x * 2) / 2;

/** The application, the job and the caller's side of it (candidate / employer); 404 for anyone else */
async function sideOf(applicationId, userId) {
  if (!isId(applicationId)) throw new RatingError(404, "NOT_FOUND", "Application not found");
  const [app, user] = await Promise.all([
    JobApplication.findById(applicationId).select("jobId userId status").lean(),
    User.findById(userId).select("role").lean(),
  ]);
  const job = app && (await Job.findById(app.jobId).select("title companyName postedBy isExternal").lean());
  if (!app || !job || !user) throw new RatingError(404, "NOT_FOUND", "Application not found");
  let side = null;
  if (same(app.userId, userId)) side = "candidate";
  else if (user.role === "employee" && same(job.postedBy, userId)) side = "employer";
  if (!side || !job.postedBy || job.isExternal) throw new RatingError(404, "NOT_FOUND", "Application not found");
  if (!flagOn(job.postedBy, "employee") || !flagOn(app.userId, "student")) throw new RatingError(404, "RATINGS_OFF", "Ratings aren't available for this application");
  return { app, job, side, employerId: String(job.postedBy), candidateId: String(app.userId) };
}

/** What can be rated on this application: completed interviews and a verified hire, each with its window */
async function eventsToRate(app, now = new Date()) {
  const events = await timeline.eventsOf(app._id);
  const state = timeline.fold(events, app.status, now);
  const out = [];
  events.forEach((e, i) => {
    if (e.type !== "INTERVIEW_COMPLETED") return;
    // a later dispute of this interview: it may not have happened as recorded
    const disputed = events.slice(i + 1).some((x) => x.type === "INTERVIEW_DISPUTED");
    if (disputed) return;
    const ref = String(e.metadata?.interviewId || e._id);
    out.push({ kind: "interview", ref, eventAt: e.occurredAt, windowEndsAt: new Date(new Date(e.occurredAt).getTime() + WINDOW_DAYS * DAY) });
  });
  const hire = [...events].reverse().find((e) => e.type === "HIRE_CONFIRMED");
  if (hire && state.hire.status === "verified") out.push({ kind: "hire", ref: "hire", eventAt: hire.occurredAt, windowEndsAt: new Date(new Date(hire.occurredAt).getTime() + WINDOW_DAYS * DAY) });
  return out.map((o) => ({ ...o, open: now < o.windowEndsAt }));
}

const keyOf = (applicationId, kind, ref, raterRole) => `${applicationId}:${kind}:${ref}:${raterRole}`;
const ownView = (r) => r && ({ id: String(r._id), kind: r.kind, answers: r.answers, comment: r.comment, createdAt: r.createdAt });

/** For the person about to rate: each event, its questions, whether the window is open, their own rating */
async function forApplication(applicationId, userId, now = new Date()) {
  const ctx = await sideOf(applicationId, userId);
  const evs = await eventsToRate(ctx.app, now);
  const mine = await CareerRating.find({ application: ctx.app._id, raterRole: ctx.side }).lean();
  return {
    side: ctx.side,
    questions: QUESTIONS[ctx.side],
    events: evs.map((e) => {
      const r = mine.find((x) => x.kind === e.kind && x.ref === e.ref);
      return { kind: e.kind, ref: e.ref, eventAt: e.eventAt, windowEndsAt: e.windowEndsAt, open: e.open && !r, myRating: ownView(r) };
    }),
  };
}

function cleanAnswers(side, answers) {
  const qs = QUESTIONS[side];
  const out = {};
  for (const q of qs) {
    const v = Number(answers?.[q.id]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new RatingError(400, "INVALID_ANSWERS", `Answer every question with 1 to 5 stars (${qs.map((x) => x.id).join(", ")})`);
    out[q.id] = v;
  }
  const extra = Object.keys(answers || {}).filter((k) => !qs.some((q) => q.id === k));
  if (extra.length) throw new RatingError(400, "INVALID_ANSWERS", `Unknown question: ${extra.join(", ")}`);
  return out;
}

/** Rate the other side once for one event. Returns { rating, created } (created false: the same rating again) */
async function rate(userId, body = {}, now = new Date()) {
  const ctx = await sideOf(body.applicationId, userId);
  const kind = body.kind;
  if (!["interview", "hire"].includes(kind)) throw new RatingError(400, "INVALID_KIND", "kind: interview or hire");
  const evs = (await eventsToRate(ctx.app, now)).filter((e) => e.kind === kind && (kind === "hire" || !body.ref || e.ref === String(body.ref)));
  const ev = evs[evs.length - 1];
  if (!ev) throw new RatingError(409, "NOT_ELIGIBLE", kind === "interview" ? "There is no completed interview to rate" : "There is no verified hire to rate");
  if (!ev.open) throw new RatingError(409, "WINDOW_CLOSED", `Ratings close ${WINDOW_DAYS} days after the ${kind}`);
  const answers = cleanAnswers(ctx.side, body.answers);
  const comment = String(body.comment || "").trim();
  if (comment.length > 300) throw new RatingError(400, "COMMENT_TOO_LONG", "Keep the comment under 300 characters");
  if (comment && findProfanity(comment)) throw new RatingError(400, "COMMENT_NOT_ALLOWED", "Please rewrite the comment without offensive words");
  const raterRole = ctx.side;
  const key = keyOf(ctx.app._id, kind, ev.ref, raterRole);
  const doc = {
    key, application: ctx.app._id, job: ctx.job._id, employer: ctx.employerId, candidate: ctx.candidateId, kind, ref: ev.ref,
    eventAt: ev.eventAt, windowEndsAt: ev.windowEndsAt, raterRole, rater: userId, ratee: raterRole === "employer" ? ctx.candidateId : ctx.employerId,
    answers, comment, createdAt: now,
  };
  let rating;
  try {
    rating = (await CareerRating.create(doc)).toObject();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await CareerRating.findOne({ key }).lean();
    // a retry of the same rating is fine; a different one isn't (one per side per event)
    if (existing && JSON.stringify(existing.answers) === JSON.stringify(answers) && existing.comment === comment) return { rating: existing, created: false };
    throw new RatingError(409, "ALREADY_RATED", "You've already rated this", { rating: ownView(existing) });
  }
  // both sides have rated: both ratings are released now
  const other = await CareerRating.findOne({ key: keyOf(ctx.app._id, kind, ev.ref, raterRole === "employer" ? "candidate" : "employer") }).lean();
  if (other) {
    await CareerRating.updateMany({ _id: { $in: [rating._id, other._id] }, releasedAt: null }, { $set: { releasedAt: now } });
    rating.releasedAt = now;
  }
  await recordSafe("career.rating.created", String(rating._id), { actor: userId, subject: { kind: "CareerRating", id: rating._id }, data: { kind, raterRole } });
  return { rating, created: true };
}

/** Released, visible ratings an employer received from candidates: the average (from 5), never comments */
async function employerSummary(employerId, now = new Date()) {
  const list = (await CareerRating.find({ ratee: employerId, raterRole: "candidate", status: "visible" }).lean()).filter((r) => released(r, now));
  const count = list.length;
  if (count < MIN_PUBLIC) return { count, shown: false, minimum: MIN_PUBLIC, average: null, questions: null };
  const avg = (f) => halfStar(list.reduce((n, r) => n + f(r), 0) / count);
  return {
    count, shown: true, minimum: MIN_PUBLIC,
    average: avg((r) => (r.answers.communication + r.answers.respect + r.answers.clarity) / 3),
    questions: QUESTIONS.candidate.map((q) => ({ id: q.id, label: q.label, average: avg((r) => r.answers[q.id]) })),
  };
}

/** The ratings someone received that they may see: a student sees each one (to report it); an employer, from 5 on, sees them anonymised */
async function received(userId, role, now = new Date()) {
  const raterRole = role === "employee" ? "candidate" : "employer";
  const list = (await CareerRating.find({ ratee: userId, raterRole, status: "visible" }).sort({ createdAt: -1 }).lean()).filter((r) => released(r, now));
  if (raterRole === "employer") {
    const jobs = new Map((await Job.find({ _id: { $in: list.map((r) => r.job) } }).select("title companyName").lean()).map((j) => [String(j._id), j]));
    const qs = QUESTIONS.employer;
    const avg = (id) => (list.length ? halfStar(list.reduce((n, r) => n + r.answers[id], 0) / list.length) : null);
    return {
      count: list.length,
      questions: qs.map((q) => ({ id: q.id, label: q.label, average: avg(q.id) })),
      ratings: list.map((r) => ({ id: String(r._id), kind: r.kind, job: { title: jobs.get(String(r.job))?.title || "", company: jobs.get(String(r.job))?.companyName || "" }, answers: r.answers, comment: r.comment, month: new Date(r.createdAt).toISOString().slice(0, 7) })),
    };
  }
  const summary = await employerSummary(userId, now);
  if (!summary.shown) return { ...summary, ratings: [] };
  // anonymised: no candidate, job or date beyond the month, in a stable order that isn't the order of events
  const ratings = list.map((r) => ({ id: String(r._id), kind: r.kind, answers: r.answers, comment: r.comment, month: new Date(r.createdAt).toISOString().slice(0, 7) }))
    .sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id));
  return { ...summary, ratings };
}

/** The person rated reports a rating as unfair */
async function report(userId, ratingId, reason) {
  if (!isId(ratingId)) throw new RatingError(404, "NOT_FOUND", "Rating not found");
  const r = await CareerRating.findById(ratingId).lean();
  if (!r || !same(r.ratee, userId) || !released(r)) throw new RatingError(404, "NOT_FOUND", "Rating not found");
  const why = String(reason || "").trim();
  if (why.length < 5) throw new RatingError(400, "REASON_REQUIRED", "Say why this rating is unfair (at least 5 characters)");
  try {
    const rep = await CareerRatingReport.create({ rating: r._id, reporter: userId, reporterRole: r.raterRole === "employer" ? "candidate" : "employer", reason: why.slice(0, 500) });
    await recordSafe("career.rating.reported", String(rep._id), { actor: userId, subject: { kind: "CareerRating", id: r._id }, data: {} });
    return rep.toObject();
  } catch (err) {
    if (err?.code === 11000) throw new RatingError(409, "ALREADY_REPORTED", "You've already reported this rating");
    throw err;
  }
}

/** Admin: the reports, with the rating and who is who (names only) */
async function reports(status = "open") {
  const filter = ["open", "hidden", "kept"].includes(status) ? { status } : {};
  const list = await CareerRatingReport.find(filter).sort({ createdAt: 1 }).limit(200).lean();
  const ratings = new Map((await CareerRating.find({ _id: { $in: list.map((x) => x.rating) } }).lean()).map((r) => [String(r._id), r]));
  const userIds = [...new Set([...ratings.values()].flatMap((r) => [String(r.rater), String(r.ratee)]))];
  const users = new Map((await User.find({ _id: { $in: userIds } }).select("name companyName role").lean()).map((u) => [String(u._id), u]));
  const jobs = new Map((await Job.find({ _id: { $in: [...ratings.values()].map((r) => r.job) } }).select("title companyName").lean()).map((j) => [String(j._id), j]));
  const who = (id) => { const u = users.get(String(id)); return { id: String(id), name: (u?.role === "employee" ? u.companyName || u.name : u?.name) || "" }; };
  return list.map((rep) => {
    const r = ratings.get(String(rep.rating));
    return {
      id: String(rep.id || rep._id), status: rep.status, reason: rep.reason, reporterRole: rep.reporterRole, createdAt: rep.createdAt,
      decisionReason: rep.decisionReason, decidedAt: rep.decidedAt,
      rating: r && { id: String(r._id), kind: r.kind, raterRole: r.raterRole, rater: who(r.rater), ratee: who(r.ratee), job: { title: jobs.get(String(r.job))?.title || "", company: jobs.get(String(r.job))?.companyName || "" }, answers: r.answers, comment: r.comment, status: r.status, createdAt: r.createdAt },
    };
  });
}

/** Admin: hide the rating, or keep it; a reason either way; recorded */
async function decide(adminId, reportId, { action, reason } = {}, now = new Date()) {
  if (!["hide", "keep"].includes(action)) throw new RatingError(400, "INVALID_ACTION", "action: hide or keep");
  const why = String(reason || "").trim();
  if (why.length < 5) throw new RatingError(400, "REASON_REQUIRED", "Give a reason (at least 5 characters)");
  if (!isId(reportId)) throw new RatingError(404, "NOT_FOUND", "Report not found");
  const rep = await CareerRatingReport.findOneAndUpdate(
    { _id: reportId, status: "open" },
    { $set: { status: action === "hide" ? "hidden" : "kept", decidedBy: adminId, decisionReason: why.slice(0, 500), decidedAt: now } },
    { returnDocument: "after" }
  ).lean();
  if (!rep) throw new RatingError(409, "ALREADY_DECIDED", "This report was already decided (or doesn't exist)");
  if (action === "hide") {
    await CareerRating.updateOne({ _id: rep.rating }, { $set: { status: "hidden", hiddenReason: why.slice(0, 500), hiddenBy: adminId, hiddenAt: now } });
    // any other open report of the same rating is settled by this
    await CareerRatingReport.updateMany({ rating: rep.rating, status: "open" }, { $set: { status: "hidden", decidedBy: adminId, decisionReason: why.slice(0, 500), decidedAt: now } });
  }
  await recordSafe(`career.rating.${action === "hide" ? "hidden" : "kept"}`, String(rep._id), { actor: adminId, subject: { kind: "CareerRating", id: rep.rating }, data: { reason: why.slice(0, 500) } });
  return rep;
}

module.exports = { RatingError, QUESTIONS, WINDOW_DAYS, MIN_PUBLIC, forApplication, rate, employerSummary, received, report, reports, decide, flagOn, released };

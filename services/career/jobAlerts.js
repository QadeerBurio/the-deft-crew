// services/career/jobAlerts.js
// "A new job that matches your skills" (FLAG_CAREER_MATCHING). When an internal job goes live (posted active, or
// switched on), students in the matching pilot whose resume shows evidence for 70%+ of its listed skills, with no
// mandatory criterion "not met", get one CareerJobAlert: at most one a day per student, never twice for the same job.
// The skill-evidence matcher only (services/career/matchingService.js): never name, university or city.
// Delivered through the pushGateway as an ordinary push with pref "jobsScholarships" (daily / weekly caps, quiet
// hours, the existing opt-out); a sent push also leaves an in-app note; a tap opens the job. Quiet hours wait for
// 09:00 if the job is still open then. External (imported) jobs, and jobs posted by employers outside the pilot,
// alert nobody. Nothing changes for accounts outside the pilot.
//   onJobLive(job)            queue the rows, then deliver in the background (never throws)
//   deliver(rowId, now)       drain({ limit, now })   (also every careerOutbox tick)
const CareerJobAlert = require("../../models/CareerJobAlert");
const Job = require("../../models/Job");
const Resume = require("../../models/Resume");
const User = require("../../models/User");
const JobApplication = require("../../models/JobApplication");
const Notification = require("../../models/Notification");
const matching = require("./matchingService");
const { isEnabled } = require("../../config/featureFlags");
const { dayKey } = require("../../utils/karachiTime");

const MIN_SCORE = 70;
const MAX_ATTEMPTS = 5;
const MAX_STUDENTS = 20000;
const MIN = 60 * 1000;
const backoff = (attempts) => Math.min(60, 2 ** attempts) * MIN;
function quietEnd(now = new Date()) {
  const k = new Date(now.getTime() + 5 * 3600e3);
  let end = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 9) - 5 * 3600e3;
  if (end <= now.getTime()) end += 24 * 3600e3;
  return new Date(end);
}
const open = (job, now) => !!job && job.active === true && !job.archivedAt && (!job.applicationDeadline || now < new Date(job.applicationDeadline));
const pilotStudent = (id) => isEnabled("careerMatching", { id: String(id), role: "student" });

async function posterInPilot(job) {
  if (!job.postedBy) return false;
  const u = await User.findById(job.postedBy).select("role").lean();
  if (!u) return false;
  return u.role === "admin" || (u.role === "employee" && isEnabled("careerMatching", { id: String(job.postedBy), role: "employee" }));
}

function payloadFor(job, m) {
  const matched = m.skills.matched.map((s) => s.skill);
  const listed = matched.length + m.skills.missing.length + m.skills.unknown.length;
  return {
    title: "A new job that matches your skills",
    body: `${job.title}${job.companyName ? ` at ${job.companyName}` : ""}: your resume shows ${matched.length} of its ${listed} skills (${matched.slice(0, 3).join(", ")}).`,
    data: { careerJobId: String(job._id), screen: "Career", params: { openJobId: String(job._id) } },
  };
}

/** Queue alerts for a job that just went live. Never throws. */
async function onJobLive(jobOrId, { now = new Date(), drainNow = true } = {}) {
  try {
    const job = jobOrId?._id ? jobOrId : await Job.findById(jobOrId).lean();
    if (!open(job, now)) return { queued: 0, reason: "job not open" };
    if (job.isExternal) return { queued: 0, reason: "external job" };
    if (!(await posterInPilot(job))) return { queued: 0, reason: "poster outside the pilot" };
    if (!(job.skills || []).length) return { queued: 0, reason: "the job lists no skills" };
    const students = (await User.find({ role: "student", "pushTokens.0": { $exists: true } }).select("_id").limit(MAX_STUDENTS).lean()).filter((s) => pilotStudent(s._id));
    if (!students.length) return { queued: 0, reason: "no pilot students" };
    const ids = students.map((s) => s._id);
    const [already, applied, resumes] = await Promise.all([
      CareerJobAlert.find({ job: job._id, student: { $in: ids } }).select("student").lean(),
      JobApplication.find({ jobId: job._id, userId: { $in: ids } }).select("userId").lean(),
      Resume.find({ user: { $in: ids } }).sort({ isPrimary: -1, updatedAt: -1 }).lean(),
    ]);
    const skip = new Set([...already.map((a) => String(a.student)), ...applied.map((a) => String(a.userId))]);
    const resumeOf = new Map();
    for (const r of resumes) if (!resumeOf.has(String(r.user))) resumeOf.set(String(r.user), r); // primary first, then newest
    const day = dayKey(now);
    let queued = 0;
    for (const s of students) {
      const sid = String(s._id);
      if (skip.has(sid) || !resumeOf.has(sid)) continue;
      const m = matching.match(job, matching.profileOf({ resume: resumeOf.get(sid) }));
      if (m.relevance.score == null || m.relevance.score < MIN_SCORE || m.mandatorySummary.notMet > 0) continue;
      try {
        await CareerJobAlert.create({ job: job._id, student: s._id, dayKey: day, key: `${sid}:${day}`, score: m.relevance.score, payload: payloadFor(job, m), expiresAt: job.applicationDeadline || new Date(now.getTime() + 30 * 864e5), nextAttemptAt: now });
        queued += 1;
      } catch (err) {
        if (err?.code !== 11000) throw err; // 11000: this student already has today's alert
      }
    }
    if (drainNow && queued) setImmediate(() => drain({ limit: 500 }).catch((e) => console.error(`[career] job alerts: ${e.message}`)));
    return { queued };
  } catch (err) {
    console.error(`[career] job alerts for a new job failed: ${err.message}`);
    return { queued: 0, error: err.message };
  }
}

async function deliver(rowId, now = new Date()) {
  const row = await CareerJobAlert.findOneAndUpdate(
    { _id: rowId, status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
    { $set: { status: "sending" }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  ).lean();
  if (!row) return null;
  let r;
  try {
    const job = await Job.findById(row.job).lean();
    if (now >= new Date(row.expiresAt) || !open(job, now)) r = { status: "skipped", error: "job no longer open" };
    else if (!pilotStudent(row.student)) r = { status: "skipped", error: "outside the pilot" };
    else if (await JobApplication.exists({ jobId: row.job, userId: row.student })) r = { status: "skipped", error: "already applied" };
    else {
      const gateway = require("../engagement/pushGateway");
      const sent = await gateway.send(row.student, { type: "job", pref: "jobsScholarships", title: row.payload.title, body: row.payload.body, data: row.payload.data });
      if (sent?.sent) {
        await Notification.create({ recipient: row.student, title: row.payload.title, description: row.payload.body, type: "Job Posting", metadata: { ...row.payload.data, jobId: String(row.job), skipPush: true, careerJobAlertId: String(row._id) } });
        r = { status: "sent" };
      } else if (sent?.reason === "quiet_hours") {
        const next = quietEnd(now);
        r = next < new Date(row.expiresAt) ? { status: "defer", next } : { status: "skipped", error: "quiet hours until the job closes" };
      } else r = { status: "skipped", error: sent?.reason || "not sent" }; // daily / weekly cap, opt-out, no token
    }
  } catch (err) {
    r = { status: "retry", error: err.message };
  }
  const update = r.status === "sent" ? { status: "sent", sentAt: now, lastError: "" }
    : r.status === "skipped" ? { status: "skipped", lastError: String(r.error || "").slice(0, 200) }
      : r.status === "defer" ? { status: "pending", lastError: "quiet_hours", nextAttemptAt: r.next, attempts: row.attempts - 1 }
        : { status: "failed", lastError: String(r.error || "").slice(0, 200), nextAttemptAt: new Date(now.getTime() + backoff(row.attempts)) };
  await CareerJobAlert.updateOne({ _id: row._id }, { $set: update });
  return { ...row, ...update };
}

async function drain({ limit = 200, now = new Date() } = {}) {
  const due = await CareerJobAlert.find({ status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select("_id").lean();
  const out = [];
  for (const d of due) out.push(await deliver(d._id, now));
  return out.filter(Boolean);
}

module.exports = { onJobLive, deliver, drain, quietEnd, MIN_SCORE };

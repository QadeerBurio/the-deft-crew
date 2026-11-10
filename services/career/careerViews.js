// services/career/careerViews.js
// Read-only lists across the hiring timeline, shared by the admin views (every employer) and the employer's own
// views (scoped to their jobs by the caller): interviews and hires. Names only (the candidate's first name, the
// employer's company); no contact details, no meeting links, no notes.
const mongoose = require("mongoose");
const Job = require("../../models/Job");
const User = require("../../models/User");
const CareerInterview = require("../../models/CareerInterview");
const CareerOutcome = require("../../models/CareerOutcome");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const firstName = (n) => String(n || "candidate").trim().split(/\s+/)[0];
const INTERVIEW_STATUSES = ["invited", "accepted", "declined", "reschedule_requested", "cancelled", "completed", "candidate_no_show_reported", "employer_no_show_reported", "disputed"];
const date = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

async function lookups(rows, { jobKey = "job", employerKey = "employer", candidateKey = "candidate" } = {}) {
  const jobIds = [...new Set(rows.map((r) => String(r[jobKey])))];
  const userIds = [...new Set(rows.flatMap((r) => [String(r[employerKey]), String(r[candidateKey])]))].filter(isId);
  const [jobs, users] = await Promise.all([
    Job.find({ _id: { $in: jobIds } }).select("title companyName").lean(),
    User.find({ _id: { $in: userIds } }).select("name companyName").lean(),
  ]);
  return { jobs: new Map(jobs.map((j) => [String(j._id), j])), users: new Map(users.map((u) => [String(u._id), u])) };
}

// filters: employerId (scope; null = every employer, admin only), jobId, status, from / to (interview start), limit;
// withJoin: also how to join (place / link), for the employer's own list only
async function listInterviews({ employerId = null, jobId = null, status = null, from = null, to = null, limit = 300, withJoin = false } = {}) {
  const q = {};
  if (employerId) q.employer = employerId;
  if (jobId) q.job = jobId;
  if (status && INTERVIEW_STATUSES.includes(String(status))) q.status = String(status);
  const f = date(from), t = date(to);
  if (f || t) q.startsAt = { ...(f ? { $gte: f } : {}), ...(t ? { $lte: t } : {}) };
  const rows = await CareerInterview.find(q).sort({ startsAt: 1 }).limit(Math.min(Math.max(Number(limit) || 300, 1), 500)).lean();
  const { jobs, users } = await lookups(rows);
  return rows.map((iv) => {
    const job = jobs.get(String(iv.job));
    const emp = users.get(String(iv.employer));
    return {
      id: String(iv._id), applicationId: String(iv.application),
      job: { id: String(iv.job), title: job?.title || "" },
      employer: { id: String(iv.employer), name: emp?.companyName || job?.companyName || emp?.name || "" },
      candidate: { id: String(iv.candidate), firstName: firstName(users.get(String(iv.candidate))?.name) },
      startsAt: iv.startsAt, endsAt: iv.endsAt, timezone: iv.timezone || "Asia/Karachi", mode: iv.mode, status: iv.status, active: !!iv.active,
      completedAt: iv.completedAt || null, rescheduled: (iv.history || []).length,
      ...(withJoin ? { location: iv.location || "", meetingLink: iv.meetingLink || "" } : {}),
    };
  });
}

// hires: "hired" outcomes (verified, employer-recorded or revoked), newest first
async function listHires({ employerId = null, jobId = null, from = null, to = null, limit = 300 } = {}) {
  const q = { outcomeType: "hired" };
  if (employerId) q.employer = employerId;
  if (jobId) q.job = jobId;
  const f = date(from), t = date(to);
  if (f || t) q.employerConfirmedAt = { ...(f ? { $gte: f } : {}), ...(t ? { $lte: t } : {}) };
  const rows = await CareerOutcome.find(q).sort({ employerConfirmedAt: -1 }).limit(Math.min(Math.max(Number(limit) || 300, 1), 500)).lean();
  const { jobs, users } = await lookups(rows);
  return rows.map((o) => {
    const job = jobs.get(String(o.job));
    const emp = users.get(String(o.employer));
    return {
      id: String(o._id), applicationId: String(o.application),
      job: { id: String(o.job), title: job?.title || "" },
      employer: { id: String(o.employer), name: emp?.companyName || job?.companyName || emp?.name || "" },
      candidate: { id: String(o.candidate), firstName: firstName(users.get(String(o.candidate))?.name) },
      verificationLevel: o.verificationLevel, confirmedAt: o.employerConfirmedAt || null, candidateConfirmedAt: o.candidateConfirmedAt || null,
      disputedAt: o.disputedAt || null, revokedAt: o.revokedAt || null,
    };
  });
}

module.exports = { listInterviews, listHires, INTERVIEW_STATUSES };

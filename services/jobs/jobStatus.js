// services/jobs/jobStatus.js
// A job's state for employers and admins, and the two changes made outside a request:
//   statusOf(job)            live | pending_verification | closed | inactive | deleted
//   companyVerified(id)      tdc approved the employer's company (EmployerCompanyVerification, any account)
//   publishPending(id)       the company was approved: its jobs waiting for verification go live (their deadline
//                            moves by the time they waited), the trial's 60 days start if not yet, matching
//                            students are told, and the employer gets an in-app note
//   closeExpired()           jobs past their deadline (or import batch) close: active false, closedAt and
//                            closedReason set (counts and dashboards follow active); each employer gets an in-app
//                            note per closed job. Run at start and every 6 hours (server.js, JOB_JOB_CLEANUP).
// Jobs already live before verification existed stay live: only new posts by an unverified company wait.
const Job = require("../../models/Job");
const Notification = require("../../models/Notification");
const EmployerCompanyVerification = require("../../models/EmployerCompanyVerification");

const DAY = 864e5;

function statusOf(job, now = new Date()) {
  if (!job) return "deleted";
  if (job.archivedAt) return "deleted";
  if (job.pendingVerification) return "pending_verification";
  if (job.closedAt && !job.active) return "closed";
  if (job.applicationDeadline && new Date(job.applicationDeadline) < now) return "closed";
  return job.active ? "live" : "inactive";
}

async function companyVerified(employerId) {
  return !!(await EmployerCompanyVerification.exists({ employerUserId: employerId, status: "approved" }));
}

const note = (recipient, title, description, metadata) =>
  Notification.create({ recipient, title, description, type: "System", icon: "briefcase", metadata: { ...metadata, skipPush: true } })
    .catch((e) => console.error(`[jobs] employer note failed: ${e.message}`));

async function publishPending(employerId, now = new Date()) {
  const jobs = await Job.find({ postedBy: employerId, pendingVerification: true, archivedAt: null }).lean();
  let published = 0;
  for (const j of jobs) {
    const waited = Math.max(0, now - new Date(j.createdAt || now));
    const deadline = j.applicationDeadline ? new Date(new Date(j.applicationDeadline).getTime() + waited) : new Date(now.getTime() + 30 * DAY);
    const done = await Job.findOneAndUpdate(
      { _id: j._id, pendingVerification: true },
      { $set: { pendingVerification: false, active: true, publishedAt: now, applicationDeadline: deadline, updatedAt: now } },
      { new: true }
    ).lean();
    if (!done) continue;
    published += 1;
    try { require("../career/jobAlerts").onJobLive(done); } catch (e) { console.error(`[jobs] alert failed: ${e.message}`); }
  }
  if (published) {
    await require("../career/hiringAccessService").afterPost(employerId, now);
    await note(employerId, "Your jobs are live", `tdc verified your company: ${published} job${published === 1 ? " is" : "s are"} now live for students.`, { kind: "jobs_published", count: published });
  }
  return published;
}

async function closeExpired(now = new Date()) {
  const due = await Job.find({ active: true, archivedAt: null, $or: [{ applicationDeadline: { $lt: now } }, { batchExpiresAt: { $lt: now } }] })
    .select("_id title postedBy applicationDeadline").limit(5000).lean();
  let closed = 0;
  for (const j of due) {
    const reason = j.applicationDeadline && new Date(j.applicationDeadline) < now ? "deadline" : "batch_expired";
    const done = await Job.findOneAndUpdate({ _id: j._id, active: true }, { $set: { active: false, closedAt: now, closedReason: reason, updatedAt: now } }, { new: true }).lean();
    if (!done) continue; // closed or switched off meanwhile
    closed += 1;
    if (done.postedBy && reason === "deadline") {
      const day = new Date(j.applicationDeadline).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium" });
      await note(done.postedBy, "Job closed", `"${j.title}" closed: its application deadline (${day}) passed. Its applicants, interviews and offers stay; you can reopen it from your jobs.`, { kind: "job_closed", jobId: String(j._id) });
    }
  }
  if (closed) console.log(`⏰ [jobs] closed ${closed} job${closed === 1 ? "" : "s"} past their deadline`);
  return closed;
}

module.exports = { statusOf, companyVerified, publishPending, closeExpired };

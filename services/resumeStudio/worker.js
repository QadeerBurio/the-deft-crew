// services/resumeStudio/worker.js
// Tailor jobs: created by POST /api/career/resume/tailor-jobs (202), run in the background in this
// process, polled by GET. A job is claimed atomically (queued -> running), so two runners never work on
// the same job. If the process restarts mid-job, the next poll sees a stale job and runs it again (up to
// MAX_ATTEMPTS). Limits per student: MAX_PER_HOUR new jobs per hour, MAX_ACTIVE queued/running at once.
const mongoose = require("mongoose");
const Resume = require("../../models/Resume");
const CareerResumeTailorJob = require("../../models/CareerResumeTailorJob");
const CareerResumeDraft = require("../../models/CareerResumeDraft");
const CareerResumeSourceConfirmation = require("../../models/CareerResumeSourceConfirmation");
const { generateSuggestions, StudioError } = require("./tailor");
const { revisionHashOf } = require("./facts");

const MAX_PER_HOUR = 10;
const MAX_ACTIVE = 2;
const MAX_ATTEMPTS = 3;
const STALE_QUEUED_MS = 60 * 1000;
const STALE_RUNNING_MS = 3 * 60 * 1000;

// the student's confirmation of this resume's current revision (uploaded resumes), or null
async function confirmationFor(resume) {
  return CareerResumeSourceConfirmation.findOne({ userId: resume.user, resumeId: resume._id, revisionHash: revisionHashOf(resume) }).lean();
}

/** Limits for a new job; throws StudioError(RATE_LIMITED | TOO_MANY_RUNNING) */
async function checkLimits(userId) {
  const since = new Date(Date.now() - 3600 * 1000);
  const [lastHour, active] = await Promise.all([
    CareerResumeTailorJob.countDocuments({ userId, createdAt: { $gte: since } }),
    CareerResumeTailorJob.countDocuments({ userId, status: { $in: ["queued", "running"] }, createdAt: { $gte: new Date(Date.now() - STALE_RUNNING_MS * MAX_ATTEMPTS) } }),
  ]);
  if (lastHour >= MAX_PER_HOUR) throw new StudioError("RATE_LIMITED", `You can tailor up to ${MAX_PER_HOUR} resumes an hour. Please try again later.`);
  if (active >= MAX_ACTIVE) throw new StudioError("TOO_MANY_RUNNING", "Please wait for your current tailoring to finish.");
}

/** Run one job (claimed atomically). Never throws. */
async function runJob(jobId) {
  const now = new Date();
  const job = await CareerResumeTailorJob.findOneAndUpdate(
    {
      _id: jobId,
      attempts: { $lt: MAX_ATTEMPTS },
      $or: [{ status: "queued" }, { status: "running", startedAt: { $lt: new Date(now - STALE_RUNNING_MS) } }],
    },
    { $set: { status: "running", startedAt: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  if (!job) return null;
  try {
    const resume = await Resume.findOne({ _id: job.resumeId, user: job.userId }).lean();
    if (!resume) throw new StudioError("RESUME_NOT_FOUND", "That resume no longer exists.");
    const result = await generateSuggestions({ resume, confirmation: await confirmationFor(resume), job: job.jobSnapshot || { requirements: [] } });
    const draft = await CareerResumeDraft.create({
      userId: job.userId,
      resumeId: job.resumeId,
      tailorJobId: job._id,
      target: { ...job.target.toObject?.() ?? job.target, excerpt: job.jobSnapshot?.excerpt || "" },
      promptVersion: result.promptVersion,
      sourceRevisionHash: result.sourceRevisionHash,
      provenance: result.provenance,
      sourceContent: result.sourceContent,
      facts: result.facts,
      suggestions: result.suggestions,
      match: result.match,
      warnings: result.warnings,
      fallback: result.fallback,
    });
    await CareerResumeTailorJob.updateOne({ _id: job._id, status: "running" }, { $set: { status: "succeeded", draftId: draft._id, finishedAt: new Date(), errorCode: "" } });
    return draft;
  } catch (err) {
    const code = err instanceof StudioError ? err.code : "TAILOR_FAILED";
    if (!(err instanceof StudioError)) console.error("[resume-studio] tailor job failed:", err?.message);
    await CareerResumeTailorJob.updateOne({ _id: job._id }, { $set: { status: "failed", errorCode: code, finishedAt: new Date() } }).catch(() => {});
    return null;
  }
}

const schedule = (jobId) => setImmediate(() => { runJob(jobId).catch(() => {}); });

/** On poll: a job stuck (process restart) is run again, or failed after MAX_ATTEMPTS. */
async function recoverIfStale(job) {
  const age = Date.now() - new Date(job.status === "running" ? job.startedAt : job.createdAt).getTime();
  const stale = (job.status === "queued" && age > STALE_QUEUED_MS) || (job.status === "running" && age > STALE_RUNNING_MS);
  if (!stale) return job;
  if (job.attempts >= MAX_ATTEMPTS) {
    await CareerResumeTailorJob.updateOne({ _id: job._id, status: job.status }, { $set: { status: "failed", errorCode: "TIMED_OUT", finishedAt: new Date() } });
    return CareerResumeTailorJob.findById(job._id).lean();
  }
  schedule(job._id);
  return job;
}

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

module.exports = { runJob, schedule, recoverIfStale, checkLimits, confirmationFor, isId, MAX_PER_HOUR, MAX_ACTIVE, MAX_ATTEMPTS, STALE_QUEUED_MS, STALE_RUNNING_MS };

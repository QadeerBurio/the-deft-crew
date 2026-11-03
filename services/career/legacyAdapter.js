// services/career/legacyAdapter.js
// The existing job routes (routes/jobs.routes.js) for applications in the hiring-timeline pilot
// (FLAG_CAREER_TIMELINE on for the job's employer and the candidate). Everything else is untouched.
//   - apply: records APPLIED on the timeline
//   - status / bulk-status: reviewed, shortlisted, rejected become timeline events (same rules, actor and
//     audit as the new routes); "hired" is refused (a verified hire needs the offer flow), and so are
//     pending / interview (the interview scheduler sets that)
//   - the old interview routes are refused: interviews of pilot applications go through /api/career
const timeline = require("./careerTimelineService");

const STATUS_EVENT = { reviewed: "REVIEWED", shortlisted: "SHORTLISTED", rejected: "REJECTED" };

// is this application in the pilot? (an internal job with an employer, both flagged)
const managed = (job, application) => !!job?.postedBy && !job.isExternal && timeline.enabledFor(job.postedBy, application?.userId);

async function recordApplied(applicationId) {
  try {
    return await timeline.recordApplied({ applicationId, source: "app" });
  } catch (err) {
    console.error(`[career] APPLIED not recorded for ${applicationId}: ${err.message}`);
    return null;
  }
}

// one old-style status change of a pilot application → { ok } or { ok: false, status, code, message }
async function statusChange({ applicationId, actorId, status, note }) {
  const type = STATUS_EVENT[status];
  if (!type) {
    return {
      ok: false,
      status: 409,
      code: "USE_CAREER_TIMELINE",
      message: status === "hired"
        ? "This application is on the hiring timeline: a hire is confirmed after the candidate accepts an offer"
        : "This application is on the hiring timeline: use the candidate pipeline to schedule interviews",
    };
  }
  try {
    const ctx = await timeline.contextFor(applicationId, actorId);
    if (ctx.role === "candidate") return { ok: false, status: 403, code: "NOT_YOUR_ACTION", message: "Only the job poster can update application status" };
    const { state } = await timeline.stateOf(ctx);
    const out = await timeline.append(ctx, { type, expectedVersion: state.version, metadata: { note }, source: "portal-legacy" });
    return { ok: true, out };
  } catch (err) {
    if (err instanceof timeline.CareerError) return { ok: false, status: err.status, code: err.code, message: err.message };
    throw err;
  }
}

const interviewRefusal = {
  message: "This application is on the hiring timeline: schedule, reschedule, cancel and complete interviews in the candidate pipeline",
  code: "USE_CAREER_TIMELINE",
};

module.exports = { managed, recordApplied, statusChange, interviewRefusal };

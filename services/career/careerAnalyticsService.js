// services/career/careerAnalyticsService.js
// The hiring funnel, counted only from timeline events (CareerApplicationEvent), per distinct application.
// Never counted: an application as a hire, a scheduled interview as completed, an accepted offer as a
// hire, a disputed / revoked outcome as verified. Applications that joined the pilot after applying
// (source "legacy") count from the step they were at, never as "submitted".
// Cohort: applications whose timeline started in [from, to]. Definitions: docs/CAREER_TIMELINE.md.
const CareerApplicationEvent = require("../../models/CareerApplicationEvent");

const HOUR = 60 * 60 * 1000;
const EMPLOYER_DECISIONS = new Set(["REVIEWED", "SHORTLISTED", "REJECTED", "INTERVIEW_INVITED", "OFFER_SENT"]);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null); // percent, 1 decimal

// jobId (optional): one job's funnel (the caller checks the job is theirs)
async function funnel({ employerId = null, jobId = null, from = null, to = null } = {}) {
  const q = employerId ? { employer: employerId } : {};
  if (jobId) q.job = jobId;
  const events = await CareerApplicationEvent.find(q).sort({ application: 1, seq: 1 }).lean();
  const byApp = new Map();
  for (const e of events) {
    const k = String(e.application);
    if (!byApp.has(k)) byApp.set(k, []);
    byApp.get(k).push(e);
  }
  const c = {
    applications: 0, submitted: 0, joinedPilotLater: 0, reviewed: 0, shortlisted: 0, rejected: 0, withdrawn: 0,
    interviewsInvited: 0, interviewsAccepted: 0, interviewsCompleted: 0, noShowReports: 0,
    offersSent: 0, offersAccepted: 0, offersDeclined: 0, verifiedHires: 0, disputes: 0,
  };
  const responseHours = [];
  const toInterviewHours = [];
  const toHireHours = [];
  for (const list of byApp.values()) {
    const first = list[0];
    const startedAt = new Date(first.occurredAt);
    if ((from && startedAt < from) || (to && startedAt > to)) continue;
    c.applications += 1;
    const has = (t) => list.some((e) => e.type === t);
    const firstOf = (pred) => list.find(pred);
    const lastIndex = (t) => list.map((e) => e.type).lastIndexOf(t);
    const submitted = first.type === "APPLIED" && first.source !== "legacy";
    if (submitted) c.submitted += 1; else c.joinedPilotLater += 1;
    if (list.some((e) => EMPLOYER_DECISIONS.has(e.type))) c.reviewed += 1;
    if (has("SHORTLISTED")) c.shortlisted += 1;
    if (has("REJECTED")) c.rejected += 1;
    if (has("WITHDRAWN")) c.withdrawn += 1;
    if (has("INTERVIEW_INVITED")) c.interviewsInvited += 1;
    if (has("INTERVIEW_ACCEPTED")) c.interviewsAccepted += 1;
    // completed and not disputed afterwards
    if (lastIndex("INTERVIEW_COMPLETED") > lastIndex("INTERVIEW_DISPUTED")) c.interviewsCompleted += 1;
    if (has("CANDIDATE_NO_SHOW_REPORTED") || has("EMPLOYER_NO_SHOW_REPORTED")) c.noShowReports += 1;
    if (has("OFFER_SENT")) c.offersSent += 1;
    if (has("OFFER_ACCEPTED")) c.offersAccepted += 1;
    if (has("OFFER_DECLINED")) c.offersDeclined += 1;
    // a verified hire: confirmed (or restored by an admin after a dispute), and not disputed / revoked afterwards
    const hire = lastIndex("HIRE_CONFIRMED");
    const verified = hire >= 0 && Math.max(hire, lastIndex("HIRE_RESTORED")) > Math.max(lastIndex("HIRE_DISPUTED"), lastIndex("HIRE_REVOKED"));
    if (verified) c.verifiedHires += 1;
    c.disputes += list.filter((e) => ["INTERVIEW_DISPUTED", "HIRE_DISPUTED", "HIRE_REVOKED"].includes(e.type)).length;
    // times, only for applications submitted through the timeline
    if (submitted) {
      const decision = firstOf((e) => EMPLOYER_DECISIONS.has(e.type));
      if (decision) responseHours.push((new Date(decision.occurredAt) - startedAt) / HOUR);
      const invite = firstOf((e) => e.type === "INTERVIEW_INVITED");
      if (invite) toInterviewHours.push((new Date(invite.occurredAt) - startedAt) / HOUR);
      if (verified) toHireHours.push((new Date(list[hire].occurredAt) - startedAt) / HOUR);
    }
  }
  return {
    range: { from, to },
    jobId: jobId ? String(jobId) : null,
    counts: c,
    conversions: {
      submittedToReviewed: ratio(c.reviewed, c.applications),
      reviewedToShortlisted: ratio(c.shortlisted, c.reviewed),
      shortlistedToCompletedInterview: ratio(c.interviewsCompleted, c.shortlisted),
      completedInterviewToOffer: ratio(c.offersSent, c.interviewsCompleted),
      offerToAccepted: ratio(c.offersAccepted, c.offersSent),
      acceptedToVerifiedHire: ratio(c.verifiedHires, c.offersAccepted),
    },
    medianHours: {
      firstEmployerResponse: median(responseHours),
      toFirstInterviewInvite: median(toInterviewHours),
      toVerifiedHire: median(toHireHours),
    },
  };
}

module.exports = { funnel, median };

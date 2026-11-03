// services/career/careerReminderService.js
// Interview reminders, 24 hours and 1 hour before, through the outbox (careerNotificationService), queued
// by the careerOutbox job every 5 minutes. Only accepted interviews of applications in the pilot
// (FLAG_CAREER_TIMELINE for the employer and the candidate). One row per interview slot
// (calendarSequence), reminder, recipient and channel: queued once, however many ticks or servers.
// Candidate: push (quiet hours hold it back) + in-app; employer: in-app. A reminder is never delivered
// after the interview starts, nor for an interview that was cancelled, declined or moved since.
const CareerInterview = require("../../models/CareerInterview");
const CareerNotificationOutbox = require("../../models/CareerNotificationOutbox");
const Job = require("../../models/Job");
const timeline = require("./careerTimelineService");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const when = (d, tz = "Asia/Karachi") => {
  try {
    return new Date(d).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return new Date(d).toISOString();
  }
};

// which reminder an interview starting `lead` ms from now is due for
const dueKind = (lead) => (lead > 0 && lead <= HOUR ? "1h" : lead > HOUR && lead <= 24 * HOUR ? "24h" : null);

async function queueDueReminders(now = new Date()) {
  const soon = await CareerInterview.find({ active: true, status: "accepted", startsAt: { $gt: now, $lte: new Date(now.getTime() + 24 * HOUR) } }).lean();
  let queued = 0;
  for (const iv of soon) {
    const kind = dueKind(new Date(iv.startsAt) - now);
    if (!kind || !timeline.enabledFor(iv.employer, iv.candidate)) continue;
    const job = await Job.findById(iv.job).select("title companyName").lean();
    const title = job?.title || "your interview";
    const company = job?.companyName || "the employer";
    const at = when(iv.startsAt, iv.timezone);
    const how = iv.mode === "online" ? "the join link is in the app" : iv.mode === "in-person" ? iv.location : "a phone call";
    const heading = kind === "1h" ? "Interview in an hour" : "Interview coming up";
    const forCandidate = { title: heading, body: `${title} at ${company}: ${at} (${iv.timezone}). ${how}.` };
    const forEmployer = { title: heading, body: `Interview for ${title}: ${at} (${iv.timezone}).` };
    const rows = [
      [iv.candidate, "push", forCandidate, "MyApplications"],
      [iv.candidate, "inapp", forCandidate, "MyApplications"],
      [iv.employer, "inapp", forEmployer, "Candidates"],
    ];
    for (const [recipient, channel, msg, screen] of rows) {
      try {
        await CareerNotificationOutbox.create({
          kind: "reminder",
          interview: iv._id,
          application: iv.application,
          eventType: kind === "1h" ? "INTERVIEW_REMINDER_1H" : "INTERVIEW_REMINDER_24H",
          recipient,
          channel,
          key: `reminder:${iv._id}:s${iv.calendarSequence || 0}:${kind}:${recipient}:${channel}`,
          payload: { ...msg, data: { applicationId: String(iv.application), interviewId: String(iv._id), sequence: iv.calendarSequence || 0, eventType: "INTERVIEW_REMINDER", screen } },
          expiresAt: iv.startsAt,
          nextAttemptAt: now,
        });
        queued += 1;
      } catch (err) {
        if (err?.code !== 11000) throw err; // already queued
      }
    }
  }
  return { checked: soon.length, queued };
}

// is a queued reminder still worth sending? (the same interview slot, still accepted)
async function stillValid(row) {
  const iv = await CareerInterview.findById(row.interview).select("active status calendarSequence").lean();
  return !!iv && iv.active && iv.status === "accepted" && Number(iv.calendarSequence || 0) === Number(row.payload?.data?.sequence || 0);
}

module.exports = { queueDueReminders, stillValid, dueKind };

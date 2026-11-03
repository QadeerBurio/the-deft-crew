// services/career/careerNotificationService.js
// Notifications for the hiring timeline, through an outbox (models/CareerNotificationOutbox).
//   - After an event commits, one row per recipient and channel is queued (unique key: a re-run queues
//     nothing new), then delivered.
//   - Channels: push through the existing pushGateway (transactional: skips the marketing caps, keeps
//     quiet hours and the student's jobs preference), in-app (Notification, without its own push), and
//     email only when a mail provider is already configured, for interviews, offers and hires.
//   - A failed delivery is retried with backoff (up to 5 attempts); a retry never repeats the event.
//   - Texts carry the job and company, never salary or contact details.
const CareerNotificationOutbox = require("../../models/CareerNotificationOutbox");
const Notification = require("../../models/Notification");
const User = require("../../models/User");
const timeline = require("./careerTimelineService");

const MAX_ATTEMPTS = 5;
const MIN = 60 * 1000;
const backoff = (attempts) => Math.min(60, 2 ** attempts) * MIN; // 2, 4, 8 ... 60 minutes

const when = (d, tz = "Asia/Karachi") => {
  try {
    return new Date(d).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(d).toISOString();
  }
};

// event → [{ to: candidate | employer, title, body, email? }]
function messagesFor(e, job) {
  const title = job?.title || "the role";
  const company = job?.companyName || "The employer";
  const m = e.metadata || {};
  const C = (t, b, email = false) => ({ to: "candidate", title: t, body: b, email });
  const E = (t, b, email = false) => ({ to: "employer", title: t, body: b, email });
  switch (e.type) {
    case "SHORTLISTED": return [C("You're shortlisted", `${company} shortlisted you for ${title}.`)];
    case "REJECTED": return [C("Application update", `${company} has moved forward with other candidates for ${title}. New roles open every week.`)];
    case "INTERVIEW_INVITED": return [C("Interview invitation", `${company} invited you to interview for ${title} on ${when(m.startsAt, m.timezone)} (${m.timezone || "Asia/Karachi"}). Accept or ask for another time.`, true)];
    case "INTERVIEW_RESCHEDULED": return [C("Interview moved", `Your interview for ${title} is now on ${when(m.startsAt, m.timezone)}. Your calendar file is updated.`, true)];
    case "INTERVIEW_CANCELLED": return [C("Interview cancelled", `${company} cancelled your interview for ${title}.`, true)];
    case "INTERVIEW_ACCEPTED": return [E("Interview accepted", `The candidate accepted the interview for ${title}.`)];
    case "INTERVIEW_DECLINED": return [E("Interview declined", `The candidate declined the interview for ${title}.`)];
    case "INTERVIEW_RESCHEDULE_REQUESTED": return [E("New time requested", `The candidate asked for another interview time for ${title}.`)];
    case "INTERVIEW_COMPLETED": return [C("Interview recorded", `${company} recorded your interview for ${title} as completed. If that's not right, you can dispute it.`)];
    case "CANDIDATE_NO_SHOW_REPORTED": return [C("Interview: no-show reported", `${company} reported that you didn't join the interview for ${title}. If that's not right, you can dispute it.`)];
    case "EMPLOYER_NO_SHOW_REPORTED": return [E("No-show reported", `The candidate reported that the interview for ${title} didn't happen on your side.`)];
    case "INTERVIEW_DISPUTED": return [E("Interview disputed", `The candidate disputed the recorded interview for ${title}.`)];
    case "OFFER_SENT": return [C("You have an offer", `${company} offered you ${title}. Answer by ${when(m.expiresAt)}.`, true)];
    case "OFFER_WITHDRAWN": return [C("Offer withdrawn", `${company} withdrew the offer for ${title}.`, true)];
    case "OFFER_ACCEPTED": return [E("Offer accepted", `The candidate accepted your offer for ${title}. Confirm the hire when they've joined.`, true)];
    case "OFFER_DECLINED": return [E("Offer declined", `The candidate declined your offer for ${title}.`)];
    case "HIRE_CONFIRMED": return [
      C("Hired via TDC", `Congratulations: ${company} confirmed your hire for ${title}. Your "Hired via TDC" record is private; you choose who sees it.`, true),
      E("Hire confirmed", `Your hire for ${title} is confirmed.`),
    ];
    case "HIRE_DISPUTED": return [E("Hire disputed", `The candidate disputed the hire for ${title}. tdc will review it.`)];
    case "HIRE_REVOKED": return [C("Hire record corrected", `The hire record for ${title} was corrected by tdc.`), E("Hire record corrected", `The hire record for ${title} was corrected by tdc.`)];
    case "WITHDRAWN": return [E("Application withdrawn", `A candidate withdrew their application for ${title}.`)];
    default: return []; // APPLIED (the apply route already notifies), REVIEWED, LEGACY_STATUS
  }
}

const mailer = () => {
  try {
    return require("../../utils/mailer");
  } catch {
    return null;
  }
};
const emailReady = () => {
  const m = mailer();
  return !!m && typeof m.mailProvider === "function" && m.mailProvider() !== "none";
};

async function enqueue(event, ctx) {
  const msgs = messagesFor(event, ctx?.job);
  const rows = [];
  for (const msg of msgs) {
    const recipient = msg.to === "candidate" ? event.candidate : event.employer;
    if (!recipient) continue;
    const channels = msg.to === "candidate" ? ["push", "inapp"] : ["inapp"];
    if (msg.email && emailReady()) channels.push("email");
    const payload = { title: msg.title, body: msg.body, data: { applicationId: String(event.application), eventType: event.type, screen: msg.to === "candidate" ? "MyApplications" : "Candidates" } };
    for (const channel of channels) {
      rows.push({ event: event._id, eventType: event.type, application: event.application, recipient, channel, key: `${event._id}:${recipient}:${channel}`, payload });
    }
  }
  let queued = 0;
  for (const r of rows) {
    try {
      await CareerNotificationOutbox.create(r);
      queued += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err; // already queued: nothing to do
    }
  }
  return queued;
}

// the providers (replaceable in tests)
const providers = {
  async push(row) {
    const gateway = require("../engagement/pushGateway");
    const r = await gateway.send(row.recipient, { type: "job", pref: "jobsScholarships", essential: true, title: row.payload.title, body: row.payload.body, data: row.payload.data });
    if (r?.sent) return { status: "sent" };
    // quiet hours: held back until later (not a failure); no profile / switched off by the student: nothing to send
    if (r?.reason === "quiet_hours") return { status: "defer", error: "quiet_hours" };
    return { status: "skipped", error: r?.reason || "not sent" };
  },
  async inapp(row) {
    await Notification.create({
      recipient: row.recipient,
      title: row.payload.title,
      description: row.payload.body,
      type: row.eventType.startsWith("INTERVIEW") ? "Interview" : "Application Status",
      metadata: { ...row.payload.data, skipPush: true, careerOutboxId: String(row._id) }, // the push is its own row
    });
    return { status: "sent" };
  },
  async email(row) {
    const user = await User.findById(row.recipient).select("email").lean();
    if (!user?.email) return { status: "skipped", error: "no email" };
    await mailer().sendMail({ to: user.email, subject: row.payload.title, text: `${row.payload.body}\n\nOpen The Deft Crew to answer.` });
    return { status: "sent" };
  },
};

async function deliver(rowId, now = new Date()) {
  // claim the row: only one deliverer per row at a time
  const row = await CareerNotificationOutbox.findOneAndUpdate(
    { _id: rowId, status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
    { $set: { status: "sending" }, $inc: { attempts: 1 } },
    { new: true }
  ).lean();
  if (!row) return null;
  let r;
  try {
    r = await providers[row.channel](row);
  } catch (err) {
    r = { status: "retry", error: err.message };
  }
  const update = r.status === "sent"
    ? { status: "sent", sentAt: now, lastError: "" }
    : r.status === "skipped"
      ? { status: "skipped", lastError: String(r.error || "").slice(0, 200) }
      : r.status === "defer"
        // held back (quiet hours): try again in 30 minutes; doesn't use up an attempt
        ? { status: "pending", lastError: String(r.error || ""), nextAttemptAt: new Date(now.getTime() + 30 * MIN), attempts: row.attempts - 1 }
        : { status: "failed", lastError: String(r.error || "").slice(0, 200), nextAttemptAt: new Date(now.getTime() + backoff(row.attempts)) };
  await CareerNotificationOutbox.updateOne({ _id: row._id }, { $set: update });
  return { ...row, ...update };
}

// deliver what's due (after each event, and on demand)
async function drain({ limit = 25, now = new Date() } = {}) {
  const due = await CareerNotificationOutbox.find({ status: { $in: ["pending", "failed"] }, attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select("_id").lean();
  const out = [];
  for (const d of due) out.push(await deliver(d._id, now));
  return out.filter(Boolean);
}

// after every committed timeline event
timeline.onEvent(async (event, ctx) => {
  await enqueue(event, ctx);
  await drain({ limit: 10 });
});

module.exports = { messagesFor, enqueue, deliver, drain, providers, MAX_ATTEMPTS };

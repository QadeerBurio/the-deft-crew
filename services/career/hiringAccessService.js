// services/career/hiringAccessService.js
// Free trial and hiring plans: who may post jobs (POST /api/jobs/add, duplicate, an employer's CSV upload).
//   - Every employer starts on a free trial. It ends at the company's first verified hire through First Hire Free
//     (the free hire is used: services/career/trialService.js, after tdc approved the company) or 60 days after
//     their first job was posted, whichever comes first. The reason is shown.
//   - Existing employers start fresh: an employer whose first job is older than the policy start date
//     (HIRING_TRIAL_START, default 2026-11-17 Pakistan time) has its 60 days from that date, and a free hire used
//     before it doesn't end the trial. Nobody is locked out on release.
//   - After the trial: posting, duplicating and CSV upload are refused with 403 POSTING_LOCKED (and extending a
//     job's deadline or switching an expired job back on). Open jobs stay open until their own deadline;
//     candidates, interviews, offers and hires keep working (nothing else checks this).
//   - "Request a plan": the employer asks (how many jobs, a note); admins are notified. An admin grants a plan by
//     hand (a number of job posts and/or a date it's valid until, with a reason), extends the trial to a date or
//     ends it; each is written to AdminActionLog. A plan's posts are counted with a conditional update (never
//     over the limit, also with two posts at once); it locks again when used up or past its date.
//   - HIRING_TRIAL_OFF=true: nothing is locked (status is still shown). No payment of any kind.
const mongoose = require("mongoose");
const User = require("../../models/User");
const Job = require("../../models/Job");
const Notification = require("../../models/Notification");
const EmployerHiringAccess = require("../../models/EmployerHiringAccess");
const EmployerPlanRequest = require("../../models/EmployerPlanRequest");
const EmployerCompanyVerification = require("../../models/EmployerCompanyVerification");
const EmployerHiringTrial = require("../../models/EmployerHiringTrial");
const adminLog = require("../adminActionLog");
const { CareerError } = require("./careerTimelineService");

const DAY = 864e5;
const TRIAL_DAYS = 60;
const policyStart = () => {
  const d = new Date(process.env.HIRING_TRIAL_START || "2026-11-17T00:00:00+05:00");
  return Number.isNaN(d.getTime()) ? new Date("2026-11-17T00:00:00+05:00") : d;
};
const enforced = () => process.env.HIRING_TRIAL_OFF !== "true";
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const later = (a, b) => new Date(Math.max(new Date(a).getTime(), new Date(b).getTime()));
const POLICY_TEXT =
  `Every new employer starts with a free trial: post jobs and hire through tdc. The trial ends at your company's first ` +
  `verified hire (your First Hire Free) or ${TRIAL_DAYS} days after your first job, whichever comes first. After it, your open ` +
  `jobs stay open until their deadline and your candidates, interviews, offers and hires keep working; to post more ` +
  `jobs, request a plan.`;
const END_LABEL = {
  free_hire_used: "your free hire is used",
  days_over: "your free trial has ended",
  extension_over: "your free trial has ended",
  ended_by_admin: "your free trial has ended",
};
const END_DETAIL = {
  free_hire_used: "your company's first verified hire through tdc was free; that ends the trial",
  days_over: `${TRIAL_DAYS} days have passed since your first job`,
  extension_over: "the extra time tdc gave you has passed",
  ended_by_admin: "tdc ended your trial",
};

// ---------- reading ----------
/** when the employer's company used its free hire (First Hire Free), or null */
async function freeHireAt(employerId) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId, status: "approved" }).select("companyGroupKey").lean();
  if (!v?.companyGroupKey) return null;
  const t = await EmployerHiringTrial.findOne({ companyGroupKey: v.companyGroupKey }).select("consumedCount consumedAt eligibilityStatus").lean();
  return t && t.consumedCount > 0 && t.consumedAt && ["used", "under_review"].includes(t.eligibilityStatus) ? new Date(t.consumedAt) : null;
}

/** when the trial's days start for this employer: their first job, or the policy date for an earlier one; null = no job yet */
function startFrom(firstJobAt) {
  return firstJobAt ? later(firstJobAt, policyStart()) : null;
}

/** the employer's access record, created on first use (existing employers: the trial starts on the policy date) */
async function load(employerId, now = new Date()) {
  let a = await EmployerHiringAccess.findOne({ employerUserId: employerId }).lean();
  if (a && a.trialStartedAt) return a;
  // the first job that went live (one waiting for company verification doesn't start the 60 days)
  const first = await Job.findOne({ postedBy: employerId, pendingVerification: { $ne: true } }).sort({ createdAt: 1 }).select("createdAt").lean();
  const startedAt = first ? startFrom(first.createdAt || now) : null;
  if (!a) {
    const why = !first ? "no job yet: the 60 days start with the first job" : new Date(first.createdAt) < policyStart() ? "existing employer: a fresh trial from the policy date" : "the 60 days started with the first job";
    try {
      a = await EmployerHiringAccess.findOneAndUpdate(
        { employerUserId: employerId },
        { $setOnInsert: { employerUserId: employerId, trialStartedAt: startedAt, history: [{ action: "trial_started", by: null, byRole: "system", reason: why, at: now }] } },
        { upsert: true, returnDocument: "after" }
      ).lean();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      a = await EmployerHiringAccess.findOne({ employerUserId: employerId }).lean();
    }
  } else if (startedAt) {
    a = (await EmployerHiringAccess.findOneAndUpdate({ _id: a._id, trialStartedAt: null }, { $set: { trialStartedAt: startedAt } }, { returnDocument: "after" }).lean())
      || (await EmployerHiringAccess.findOne({ _id: a._id }).lean());
  }
  return a;
}

/** the trial and the plan worked out at `now` (pure) */
function stateOf(a, hireAt, now = new Date()) {
  const start = a?.trialStartedAt ? new Date(a.trialStartedAt) : null;
  const ext = a?.extendedUntil ? new Date(a.extendedUntil) : null;
  const dayEnd = ext || (start ? new Date(start.getTime() + TRIAL_DAYS * DAY) : null);
  // a free hire ends the trial: one used since the policy start, and after the admin's last extension
  const hireCounts = !!hireAt && hireAt >= policyStart() && (!a?.extendedAt || hireAt > new Date(a.extendedAt));
  let trial;
  if (a?.endedByAdminAt) trial = { status: "ended", endReason: "ended_by_admin", endedAt: new Date(a.endedByAdminAt) };
  else if (hireCounts) trial = { status: "ended", endReason: "free_hire_used", endedAt: hireAt };
  else if (dayEnd && now >= dayEnd) trial = { status: "ended", endReason: ext ? "extension_over" : "days_over", endedAt: dayEnd };
  else trial = { status: "active", endReason: null, endedAt: null };
  Object.assign(trial, {
    startedAt: start, endsAt: dayEnd, extendedUntil: ext, clockStarted: !!start, days: TRIAL_DAYS,
    daysLeft: trial.status === "active" && dayEnd ? Math.max(0, Math.ceil((dayEnd - now) / DAY)) : null,
    freeHireUsed: hireCounts, freeHireUsedAt: hireCounts ? hireAt : null,
    label: trial.status === "active" ? "free trial" : END_LABEL[trial.endReason], detail: trial.status === "active" ? null : END_DETAIL[trial.endReason],
  });
  let plan = null;
  if (a?.plan) {
    const p = a.plan;
    const granted = p.jobsGranted == null ? null : Number(p.jobsGranted);
    const used = Number(p.jobsUsed) || 0;
    const validUntil = p.validUntil ? new Date(p.validUntil) : null;
    const status = validUntil && now >= validUntil ? "expired" : granted != null && used >= granted ? "used_up" : "active";
    plan = { status, jobsGranted: granted, jobsUsed: used, jobsLeft: granted == null ? null : Math.max(0, granted - used), validUntil, grantedAt: p.grantedAt, reason: p.reason || "" };
  }
  const canPost = !enforced() || trial.status === "active" || plan?.status === "active";
  return { trial, plan, canPost, enforced: enforced() };
}

const lockMessage = (s) => {
  const t = s.trial;
  if (s.plan && s.plan.status === "used_up") return "Your plan's job posts are used. Request a plan to post more jobs.";
  if (s.plan && s.plan.status === "expired") return "Your plan has ended. Request a plan to post more jobs.";
  const head = t.endReason === "free_hire_used" ? "Your free hire is used, so your free trial has ended" : "Your free trial has ended";
  return `${head}. Your open jobs stay open until their deadline; request a plan to post more jobs.`;
};
const lockError = (s) => new CareerError(403, "POSTING_LOCKED", lockMessage(s), { reason: s.plan && s.plan.status !== "active" ? `plan_${s.plan.status}` : s.trial.endReason, trial: { status: s.trial.status, endReason: s.trial.endReason, endedAt: s.trial.endedAt }, plan: s.plan ? { status: s.plan.status, jobsLeft: s.plan.jobsLeft, validUntil: s.plan.validUntil } : null });

/** the employer's state now (creates the access record on first use) */
async function status(employerId, now = new Date()) {
  const [a, hireAt] = await Promise.all([load(employerId, now), freeHireAt(employerId)]);
  return { access: a, ...stateOf(a, hireAt, now) };
}

// ---------- posting ----------
/**
 * Before an employer posts `n` jobs: allowed on the trial (nothing counted) or within an active plan (counted now,
 * with a conditional update). Throws 403 POSTING_LOCKED otherwise. Returns { via, release() } — release() gives the
 * counted posts back when the job couldn't be saved.
 */
async function reserve(employerId, n = 1, now = new Date()) {
  const s = await status(employerId, now);
  const none = { release: async () => {} };
  if (!s.enforced) return { via: "off", ...none };
  if (s.trial.status === "active") return { via: "trial", ...none };
  if (s.plan?.status === "active") {
    const p = s.access.plan;
    const filter = { employerUserId: employerId, "plan.grantedAt": p.grantedAt };
    if (p.jobsGranted != null) filter["plan.jobsUsed"] = { $lte: Number(p.jobsGranted) - n };
    if (p.validUntil) filter["plan.validUntil"] = { $gt: now };
    const done = await EmployerHiringAccess.findOneAndUpdate(filter, { $inc: { "plan.jobsUsed": n } }, { returnDocument: "after" }).lean();
    if (done) {
      return { via: "plan", release: () => EmployerHiringAccess.updateOne({ employerUserId: employerId, "plan.grantedAt": p.grantedAt, "plan.jobsUsed": { $gte: n } }, { $inc: { "plan.jobsUsed": -n } }).catch(() => {}) };
    }
    // used up by a post at the same moment
    throw lockError(stateOf(await EmployerHiringAccess.findOne({ employerUserId: employerId }).lean(), s.trial.freeHireUsedAt, now));
  }
  throw lockError(s);
}

/** after an employer's job was saved: the trial's 60 days start with the first job */
async function afterPost(employerId, now = new Date()) {
  await EmployerHiringAccess.updateOne(
    { employerUserId: employerId, trialStartedAt: null },
    { $set: { trialStartedAt: later(now, policyStart()) }, $push: { history: { action: "clock_started", by: null, byRole: "system", reason: "first job posted", at: now } } }
  ).catch((e) => console.error(`[hiring access] clock start failed: ${e.message}`));
}

/** may the employer extend a deadline / switch a closed job back on? (trial or an active plan; nothing counted) */
async function canRepost(employerId, now = new Date()) {
  const s = await status(employerId, now);
  if (!s.canPost) throw lockError(s);
  return true;
}

// ---------- the employer's view ----------
const dateOrNull = (d) => (d ? new Date(d).toISOString() : null);
function viewOf(s, openRequest) {
  const t = s.trial;
  return {
    canPost: s.canPost,
    enforced: s.enforced,
    trial: { status: t.status, label: t.label, detail: t.detail, endReason: t.endReason, endedAt: dateOrNull(t.endedAt), startedAt: dateOrNull(t.startedAt), endsAt: dateOrNull(t.endsAt), daysLeft: t.daysLeft, clockStarted: t.clockStarted, days: t.days, extendedUntil: dateOrNull(t.extendedUntil), freeHireUsed: t.freeHireUsed, freeHireUsedAt: dateOrNull(t.freeHireUsedAt) },
    plan: s.plan ? { status: s.plan.status, jobsGranted: s.plan.jobsGranted, jobsUsed: s.plan.jobsUsed, jobsLeft: s.plan.jobsLeft, validUntil: dateOrNull(s.plan.validUntil), grantedAt: dateOrNull(s.plan.grantedAt) } : null,
    lock: s.canPost ? null : { code: "POSTING_LOCKED", message: lockMessage(s) },
    request: openRequest ? { id: String(openRequest._id), jobs: openRequest.jobs, note: openRequest.note, status: openRequest.status, sentAt: dateOrNull(openRequest.updatedAt || openRequest.createdAt) } : null,
    policy: { text: POLICY_TEXT, trialDays: TRIAL_DAYS },
  };
}

async function viewFor(employerId, now = new Date()) {
  const s = await status(employerId, now);
  const open = await EmployerPlanRequest.findOne({ employerUserId: employerId, status: "open" }).lean();
  return viewOf(s, open);
}

// ---------- request a plan ----------
async function requestPlan(employerId, body = {}, now = new Date()) {
  const jobs = Number(body.jobs);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 100) throw new CareerError(400, "INVALID_JOBS", "How many jobs? A whole number from 1 to 100", { field: "jobs" });
  const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const existing = await EmployerPlanRequest.findOne({ employerUserId: employerId, status: "open" }).lean();
  const req = existing
    ? await EmployerPlanRequest.findOneAndUpdate({ _id: existing._id, status: "open" }, { $set: { jobs, note } }, { returnDocument: "after" }).lean()
    : (await EmployerPlanRequest.create({ employerUserId: employerId, jobs, note })).toObject();
  if (!existing) {
    // admins are told (in the app's notifications; the hiring plans page lists it)
    const [me, admins] = await Promise.all([User.findById(employerId).select("name companyName").lean(), User.find({ role: "admin" }).select("_id").lean()]);
    const who = me?.companyName || me?.name || "An employer";
    for (const ad of admins) {
      await Notification.create({ recipient: ad._id, title: "Hiring plan request", description: `${who} asked for a hiring plan: ${jobs} job${jobs === 1 ? "" : "s"}.`, type: "Alert", icon: "briefcase", metadata: { kind: "hiring_plan_request", employerId: String(employerId), requestId: String(req._id) } })
        .catch((e) => console.error(`[hiring access] admin notification failed: ${e.message}`));
    }
  }
  return { request: req, created: !existing };
}

// ---------- admin ----------
const needReason = (reason) => {
  const r = String(reason || "").trim();
  if (r.length < 3) throw new CareerError(400, "REASON_REQUIRED", "Write the reason for this decision", { field: "reason" });
  return r.slice(0, 500);
};
const futureDate = (v, field, now) => {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw new CareerError(400, "INVALID_DATE", "Pick a date", { field });
  if (d <= now) throw new CareerError(400, "INVALID_DATE", "The date must be in the future", { field });
  return d;
};
async function employerOrThrow(employerId) {
  const u = isId(employerId) ? await User.findById(employerId).select("role name companyName").lean() : null;
  if (!u || u.role !== "employee") throw new CareerError(404, "NOT_FOUND", "Employer not found");
  return u;
}
const summaryOf = (s) => ({ trial: s.trial.status, endReason: s.trial.endReason, endsAt: dateOrNull(s.trial.endsAt), plan: s.plan ? { status: s.plan.status, jobsGranted: s.plan.jobsGranted, jobsUsed: s.plan.jobsUsed, validUntil: dateOrNull(s.plan.validUntil) } : null, canPost: s.canPost });

/** grant a plan by hand: { jobs (1-1000) and/or validUntil (a future date), reason, requestId? }; replaces the plan */
async function grantPlan(adminId, employerId, body = {}, { requestId: reqId = null, now = new Date() } = {}) {
  const reason = needReason(body.reason);
  await employerOrThrow(employerId);
  const hasJobs = body.jobs !== undefined && body.jobs !== null && body.jobs !== "";
  const jobs = hasJobs ? Number(body.jobs) : null;
  if (hasJobs && (!Number.isInteger(jobs) || jobs < 1 || jobs > 1000)) throw new CareerError(400, "INVALID_JOBS", "Job posts: a whole number from 1 to 1000", { field: "jobs" });
  const validUntil = body.validUntil ? futureDate(body.validUntil, "validUntil", now) : null;
  if (!hasJobs && !validUntil) throw new CareerError(400, "PLAN_EMPTY", "Give a number of job posts, a date it's valid until, or both", { field: "jobs" });
  const before = await status(employerId, now);
  const plan = { jobsGranted: jobs, jobsUsed: 0, validUntil, grantedAt: now, grantedBy: adminId, reason };
  await EmployerHiringAccess.updateOne({ employerUserId: employerId }, { $set: { plan }, $inc: { version: 1 }, $push: { history: { action: "plan_granted", by: adminId, byRole: "admin", reason, detail: { jobs, validUntil }, at: now } } });
  const after = await status(employerId, now);
  const requestFilter = { employerUserId: employerId, status: "open", ...(isId(body.requestId) ? { _id: body.requestId } : {}) };
  await EmployerPlanRequest.updateMany(requestFilter, { $set: { status: "granted", resolvedAt: now, resolvedBy: adminId, resolution: reason } });
  await adminLog.record({ adminId, action: "hiring.plan.grant", targetType: "EmployerHiringAccess", targetId: String(employerId), before: summaryOf(before), after: { ...summaryOf(after), jobsGranted: jobs, validUntil: dateOrNull(validUntil) }, reason, requestId: reqId });
  await Notification.create({ recipient: employerId, title: "Your hiring plan is ready", description: `You can post ${jobs != null ? `${jobs} job${jobs === 1 ? "" : "s"}` : "jobs"}${validUntil ? ` until ${validUntil.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium" })}` : ""}.`, type: "System", icon: "briefcase", metadata: { kind: "hiring_plan_granted" } })
    .catch((e) => console.error(`[hiring access] employer notification failed: ${e.message}`));
  return after;
}

/** extend the trial to a date (it's active until then; a hire before now doesn't end it) */
async function extendTrial(adminId, employerId, body = {}, { requestId: reqId = null, now = new Date() } = {}) {
  const reason = needReason(body.reason);
  await employerOrThrow(employerId);
  const until = futureDate(body.until, "until", now);
  const before = await status(employerId, now);
  await EmployerHiringAccess.updateOne({ employerUserId: employerId }, { $set: { extendedUntil: until, extendedAt: now, endedByAdminAt: null }, $inc: { version: 1 }, $push: { history: { action: "trial_extended", by: adminId, byRole: "admin", reason, detail: { until }, at: now } } });
  const after = await status(employerId, now);
  await adminLog.record({ adminId, action: "hiring.trial.extend", targetType: "EmployerHiringAccess", targetId: String(employerId), before: summaryOf(before), after: { ...summaryOf(after), extendedUntil: dateOrNull(until) }, reason, requestId: reqId });
  return after;
}

/** end the trial now (a plan, if any, still applies) */
async function endTrial(adminId, employerId, body = {}, { requestId: reqId = null, now = new Date() } = {}) {
  const reason = needReason(body.reason);
  await employerOrThrow(employerId);
  const before = await status(employerId, now);
  if (before.trial.status !== "active") throw new CareerError(409, "TRIAL_NOT_ACTIVE", "The trial has already ended");
  await EmployerHiringAccess.updateOne({ employerUserId: employerId }, { $set: { endedByAdminAt: now, extendedUntil: null }, $inc: { version: 1 }, $push: { history: { action: "trial_ended", by: adminId, byRole: "admin", reason, at: now } } });
  const after = await status(employerId, now);
  await adminLog.record({ adminId, action: "hiring.trial.end", targetType: "EmployerHiringAccess", targetId: String(employerId), before: summaryOf(before), after: summaryOf(after), reason, requestId: reqId });
  return after;
}

async function declineRequest(adminId, id, body = {}, { requestId: reqId = null, now = new Date() } = {}) {
  const reason = needReason(body.reason);
  const r = isId(id) ? await EmployerPlanRequest.findOneAndUpdate({ _id: id, status: "open" }, { $set: { status: "declined", resolvedAt: now, resolvedBy: adminId, resolution: reason } }, { returnDocument: "after" }).lean() : null;
  if (!r) throw new CareerError(404, "NOT_FOUND", "No open request with that id");
  await adminLog.record({ adminId, action: "hiring.plan.decline", targetType: "EmployerPlanRequest", targetId: String(r._id), before: { status: "open", jobs: r.jobs }, after: { status: "declined" }, reason, requestId: reqId });
  return r;
}

/**
 * The admin "hiring plans" page: every employer's trial / plan, the requests, and counts — including how many
 * employers would have been locked on release without the fresh start (first job 60+ days before the policy date,
 * or a free hire already used).
 */
async function adminOverview(now = new Date()) {
  const employers = await User.find({ role: "employee" }).select("name companyName createdAt").sort({ createdAt: -1 }).limit(2000).lean();
  const ids = employers.map((u) => u._id);
  const [accesses, jobs, verifs, requests] = await Promise.all([
    EmployerHiringAccess.find({ employerUserId: { $in: ids } }).lean(),
    Job.find({ postedBy: { $in: ids }, pendingVerification: { $ne: true } }).select("postedBy createdAt active applicationDeadline archivedAt").lean(),
    EmployerCompanyVerification.find({ employerUserId: { $in: ids }, status: "approved" }).select("employerUserId companyGroupKey").lean(),
    EmployerPlanRequest.find({}).sort({ createdAt: -1 }).limit(300).lean(),
  ]);
  const trials = await EmployerHiringTrial.find({ companyGroupKey: { $in: verifs.map((v) => v.companyGroupKey) } }).select("companyGroupKey consumedCount consumedAt eligibilityStatus").lean();
  const trialOf = new Map(trials.map((t) => [t.companyGroupKey, t]));
  const hireOf = new Map(verifs.map((v) => {
    const t = trialOf.get(v.companyGroupKey);
    return [String(v.employerUserId), t && t.consumedCount > 0 && t.consumedAt && ["used", "under_review"].includes(t.eligibilityStatus) ? new Date(t.consumedAt) : null];
  }));
  const accessOf = new Map(accesses.map((a) => [String(a.employerUserId), a]));
  const jobsOf = new Map();
  for (const j of jobs) {
    const k = String(j.postedBy);
    if (!jobsOf.has(k)) jobsOf.set(k, []);
    jobsOf.get(k).push(j);
  }
  const ps = policyStart();
  let wouldBeLocked = 0;
  const rows = employers.map((u) => {
    const k = String(u._id);
    const mine = jobsOf.get(k) || [];
    const first = mine.reduce((m, j) => (!m || new Date(j.createdAt) < m ? new Date(j.createdAt) : m), null);
    if (first && first < ps && (ps - first >= TRIAL_DAYS * DAY || (hireOf.get(k) && hireOf.get(k) < ps))) wouldBeLocked += 1;
    // no record yet: worked out as load() would create it (nothing is written by reading this page)
    const a = accessOf.get(k) || { employerUserId: u._id, trialStartedAt: startFrom(first) };
    const s = stateOf(a.trialStartedAt ? a : { ...a, trialStartedAt: startFrom(first) }, hireOf.get(k) || null, now);
    return {
      employer: { id: k, name: u.name || "", companyName: u.companyName || "" },
      ...viewOf(s, null),
      jobs: { posted: mine.length, open: mine.filter((j) => j.active && !j.archivedAt && (!j.applicationDeadline || new Date(j.applicationDeadline) >= now)).length, firstAt: dateOrNull(first) },
      history: (a.history || []).slice(-10).map((h) => ({ action: h.action, byRole: h.byRole, reason: h.reason, at: dateOrNull(h.at) })),
    };
  });
  const nameOf = new Map(employers.map((u) => [String(u._id), u.companyName || u.name || ""]));
  return {
    policyStart: ps.toISOString(),
    trialDays: TRIAL_DAYS,
    enforced: enforced(),
    counts: {
      employers: rows.length,
      onTrial: rows.filter((r) => r.trial.status === "active").length,
      trialEnded: rows.filter((r) => r.trial.status !== "active").length,
      onPlan: rows.filter((r) => r.plan?.status === "active").length,
      locked: rows.filter((r) => !r.canPost).length,
      openRequests: requests.filter((r) => r.status === "open").length,
      wouldBeLockedWithoutFreshStart: wouldBeLocked,
    },
    employers: rows,
    requests: requests.map((r) => ({ id: String(r._id), employer: { id: String(r.employerUserId), name: nameOf.get(String(r.employerUserId)) || "" }, jobs: r.jobs, note: r.note, status: r.status, sentAt: dateOrNull(r.updatedAt || r.createdAt), resolvedAt: dateOrNull(r.resolvedAt), resolution: r.resolution })),
  };
}

module.exports = {
  TRIAL_DAYS, POLICY_TEXT, policyStart, enforced, stateOf, status, load, freeHireAt, reserve, afterPost, canRepost, viewFor,
  requestPlan, grantPlan, extendTrial, endTrial, declineRequest, adminOverview, lockError,
};

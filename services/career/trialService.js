// services/career/trialService.js
// First Hire Free (FLAG_EMPLOYER_FIRST_HIRE_FREE): one fee-waived verified hire per verified company group.
//   1. The employer submits company details (name, NTN or SECP number, business e-mail domain, website).
//      Free-mail domains are refused. Same registration number, domain or website as another account =
//      the same company group -> duplicate_review. An admin approves, rejects or marks a duplicate.
//   2. Approved: the employer activates the trial (idempotent; one per company group, shared by its
//      approved accounts).
//   3. The trial is consumed only when a Sprint 3 hire becomes verified (HIRE_CONFIRMED: offer accepted +
//      employer confirmed), once per hire event: a conditional update on the trial plus a billing event
//      with a unique key. Any other verified hire is recorded as hire_billable_pending_pricing (amount null).
//      Applications, shortlists, interviews and offers never touch it.
//   4. A hire revoked within 7 days of its confirmation (candidate dispute or admin) restores the trial
//      (free_hire_restored); revoked later, the trial goes to under_review for an admin.
//   5. An admin who rejects the dispute restores the hire (HIRE_RESTORED): it counts again, once. If this hire
//      no longer holds anything in the ledger, it uses the free hire when the trial is still active and unused,
//      else it is recorded as hire_billable_pending_pricing. If it still holds its free hire or a pending row
//      (the dispute came after the 7 days, or it was never free), nothing new is recorded. Audited.
// Nothing here charges anyone: the ledger only records. Hooks run after the timeline event commits
// (careerTimelineService.onEvent) and never throw into it; a hire missed by a hook is picked up later by
// reconcile() (same keys, so never twice).
const mongoose = require("mongoose");
const User = require("../../models/User");
const Job = require("../../models/Job");
const JobApplication = require("../../models/JobApplication");
const CareerApplicationEvent = require("../../models/CareerApplicationEvent");
const CareerInterview = require("../../models/CareerInterview");
const CareerOutcome = require("../../models/CareerOutcome");
const EmployerCompanyVerification = require("../../models/EmployerCompanyVerification");
const EmployerHiringTrial = require("../../models/EmployerHiringTrial");
const EmployerHiringBillingEvent = require("../../models/EmployerHiringBillingEvent");
const CareerAdminAudit = require("../../models/CareerAdminAudit");
const { isEnabled } = require("../../config/featureFlags");
const { recordSafe } = require("../domainEvents");
const timeline = require("./careerTimelineService");

const { CareerError } = timeline;
const POLICY_VERSION = "fhf-2026-11";
const DAY = 864e5;
const RESTORE_DAYS = timeline.DISPUTE_DAYS; // 7
const POLICY_TEXT =
  "Your company's first verified hire through tdc is free: no fee for one hire per verified company. " +
  "A hire is verified when the candidate accepts your offer and you confirm the hire. Posting jobs, applications, " +
  "shortlists, interviews and offers don't use it. If a hire is disputed and revoked within 7 days, your free hire " +
  "comes back. Pricing for further hires is coming soon; nothing is charged today.";
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => String(a) === String(b);
const flagOn = (userId) => isEnabled("employerFirstHireFree", { id: String(userId) });
// set up = the Railway value, or any admin access (config/featureFlags.js pilotConfigured)
const pilotConfigured = () => require("../../config/featureFlags").pilotConfigured("employerFirstHireFree");

// ---------- company details ----------
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|outlook|hotmail|live|msn|windowslive|icloud|me|mac|aol|proton|protonmail|pm|gmx|yandex|mail|zoho|zohomail|rediffmail|inbox|tutanota|tuta|fastmail|hushmail|qq|163|126|sina|naver|daum|hanmail|web|t-online|orange|free|laposte|libero|virgilio|seznam|wp|o2|interia|onet|rambler|ukr|bigpond|optusnet|shaw|rogers|sympatico|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|juno|netzero|lycos|excite|aim|email|usa|post|consultant|engineer|myself|dr|cyber)\./i;
const hostOf = (v) => String(v || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
const validHost = (h) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(h);
const freeMail = (domain) => FREE_MAIL.test(domain);
function normalizeRegistration(raw) {
  const v = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  // NTN: 7 digits + check digit (7-8), or a 13-digit CNIC-based NTN; SECP: an incorporation number, digits
  // with an optional short prefix
  if (!/^[A-Z]{0,4}\d{7,13}$/.test(v)) return null;
  return v;
}

/** Validate and normalize what the employer typed; throws 400 with the field */
function cleanDetails(body) {
  const companyName = String(body?.companyName || "").replace(/\s+/g, " ").trim();
  if (companyName.length < 2 || companyName.length > 120) throw new CareerError(400, "INVALID_COMPANY_NAME", "Enter the company's registered name", { field: "companyName" });
  const registrationType = body?.registrationType === "secp" ? "secp" : "ntn";
  const ntnOrSecp = normalizeRegistration(body?.ntnOrSecp);
  if (!ntnOrSecp) throw new CareerError(400, "INVALID_REGISTRATION", "Enter the NTN (e.g. 1234567-8) or the SECP incorporation number", { field: "ntnOrSecp" });
  const businessEmailDomain = hostOf(String(body?.businessEmailDomain || "").replace(/^.*@/, ""));
  if (!validHost(businessEmailDomain)) throw new CareerError(400, "INVALID_DOMAIN", "Enter your company's e-mail domain, e.g. yourcompany.pk", { field: "businessEmailDomain" });
  if (freeMail(businessEmailDomain)) throw new CareerError(400, "FREE_MAIL_DOMAIN", "Use your company's own e-mail domain, not a free e-mail service (Gmail, Yahoo, Outlook, Hotmail ...)", { field: "businessEmailDomain" });
  const website = hostOf(body?.website);
  if (!validHost(website)) throw new CareerError(400, "INVALID_WEBSITE", "Enter the company's website, e.g. yourcompany.pk", { field: "website" });
  if (freeMail(website)) throw new CareerError(400, "INVALID_WEBSITE", "Enter the company's own website", { field: "website" });
  return { companyName, registrationType, ntnOrSecp, businessEmailDomain, website };
}

const endsWithDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Submit (or update before approval) the employer's company details */
async function submitVerification(employerId, body, now = new Date()) {
  const d = cleanDetails(body);
  const existing = await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean();
  if (existing?.status === "approved") {
    const unchanged = ["companyName", "ntnOrSecp", "businessEmailDomain", "website"].every((k) => existing[k] === d[k]);
    if (unchanged) return { verification: existing, created: false };
    throw new CareerError(409, "ALREADY_APPROVED", "Your company is verified; contact tdc to change its details");
  }
  if (existing && ["companyName", "registrationType", "ntnOrSecp", "businessEmailDomain", "website"].every((k) => existing[k] === d[k]) && existing.status !== "rejected") {
    return { verification: existing, created: false }; // the same details again
  }
  const me = await User.findById(employerId).select("email").lean();
  const signInDomain = hostOf(String(me?.email || "").split("@")[1] || "");
  // another account of the same company? same registration number, e-mail domain or website
  const others = await EmployerCompanyVerification.find({
    employerUserId: { $ne: employerId },
    status: { $in: ["pending", "approved", "duplicate_review"] },
    $or: [{ ntnOrSecp: d.ntnOrSecp }, { businessEmailDomain: d.businessEmailDomain }, { website: d.website }],
  }).select("_id employerUserId companyGroupKey ntnOrSecp businessEmailDomain website status").lean();
  const duplicateOf = others.map((o) => ({
    verificationId: o._id, employerUserId: o.employerUserId,
    matchedOn: [o.ntnOrSecp === d.ntnOrSecp && "registration number", o.businessEmailDomain === d.businessEmailDomain && "e-mail domain", o.website === d.website && "website"].filter(Boolean),
  }));
  const groupFrom = others.find((o) => o.status === "approved") || others[0];
  const fields = {
    ...d, companyGroupKey: groupFrom ? groupFrom.companyGroupKey : `reg:${d.ntnOrSecp}`,
    signInEmailMatchesDomain: !!signInDomain && endsWithDomain(signInDomain, d.businessEmailDomain),
    websiteMatchesDomain: endsWithDomain(d.website, d.businessEmailDomain) || endsWithDomain(d.businessEmailDomain, d.website),
    status: duplicateOf.length ? "duplicate_review" : "pending", duplicateOf, reviewedBy: null, reviewedAt: null, reason: "",
  };
  const entry = { action: existing ? "resubmitted" : "submitted", status: fields.status, by: employerId, byRole: "employer", reason: duplicateOf.length ? `matches another account on ${[...new Set(duplicateOf.flatMap((x) => x.matchedOn))].join(", ")}` : "", at: now };
  try {
    const v = await EmployerCompanyVerification.findOneAndUpdate(
      { employerUserId: employerId, status: { $ne: "approved" } },
      { $set: fields, $push: { history: entry } },
      { upsert: true, returnDocument: "after" }
    ).lean();
    recordSafe("career.company_verification_submitted", `${v._id}:${v.history.length}`, { actor: employerId, subject: { kind: "EmployerCompanyVerification", id: v._id }, data: { status: v.status } });
    return { verification: v, created: !existing };
  } catch (err) {
    if (err?.code === 11000) return { verification: await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean(), created: false };
    throw err;
  }
}

// ---------- the trial ----------
async function trialOfGroup(groupKey) {
  return groupKey ? EmployerHiringTrial.findOne({ companyGroupKey: groupKey }).lean() : null;
}

/** Activate the company's trial: only once its details are approved; idempotent; one per company group */
async function activate(employerId, now = new Date()) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean();
  if (!v) throw new CareerError(409, "VERIFY_COMPANY_FIRST", "Verify your company first");
  if (v.status !== "approved") throw new CareerError(409, "VERIFICATION_NOT_APPROVED", v.status === "rejected" ? "Your company details weren't approved. Check the reason and submit them again." : "tdc is still checking your company details", { status: v.status });
  const existing = await trialOfGroup(v.companyGroupKey);
  if (existing) return { trial: existing, created: false }; // already activated (by this or another account of the company)
  try {
    const trial = (await EmployerHiringTrial.create({
      companyGroupKey: v.companyGroupKey, activatedBy: employerId, verifiedAt: v.reviewedAt || now, policyVersion: POLICY_VERSION,
      history: [{ action: "activated", status: "active", by: employerId, byRole: "employer", reason: "", at: now }],
    })).toObject();
    recordSafe("career.trial_activated", String(trial._id), { actor: employerId, subject: { kind: "EmployerHiringTrial", id: trial._id }, data: {} });
    return { trial, created: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return { trial: await trialOfGroup(v.companyGroupKey), created: false }; // two taps at once
  }
}

const remainingOf = (t) => (t && t.eligibilityStatus === "active" ? Math.max(0, t.entitlementCount - t.consumedCount) : 0);
function nextActionOf(v, t) {
  if (!v || v.status === "rejected") return { action: "verify_company", label: v ? "fix your company details" : "verify your company" };
  if (v.status !== "approved") return { action: "wait_for_review", label: "tdc is checking your company details" };
  if (!t) return { action: "activate", label: "activate your free hire" };
  if (t.eligibilityStatus === "active") return { action: "post_job", label: "post a job and hire through tdc" };
  if (t.eligibilityStatus === "under_review") return { action: "wait_for_review", label: "tdc is reviewing your free hire" };
  return { action: "none", label: "pricing for further hires is coming soon" };
}

/** The employer's view: their own company details (incl. registration number), the trial and the next step */
async function viewFor(employerId) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId }).lean();
  if (v?.status === "approved") await reconcile({ companyGroupKey: v.companyGroupKey }).catch((e) => console.error(`[trial] reconcile failed: ${e.message}`));
  const t = v?.status === "approved" ? await trialOfGroup(v.companyGroupKey) : null;
  return {
    enabled: true,
    status: t ? t.eligibilityStatus : "not_activated",
    remainingFreeHires: remainingOf(t),
    usedOn: t?.consumedAt || null,
    nextAction: nextActionOf(v, t),
    policy: { version: POLICY_VERSION, text: POLICY_TEXT, furtherHires: "Pricing for further hires is coming soon." },
    verification: v ? {
      id: String(v._id), status: v.status, companyName: v.companyName, registrationType: v.registrationType, ntnOrSecp: v.ntnOrSecp,
      businessEmailDomain: v.businessEmailDomain, website: v.website, reason: v.reason || "", reviewedAt: v.reviewedAt, submittedAt: v.createdAt,
    } : null,
  };
}

/** Real counts for the employer's own jobs: no estimates */
async function summaryFor(employerId) {
  const jobs = await Job.find({ postedBy: employerId }).select("_id").lean();
  const jobIds = jobs.map((j) => j._id);
  const [applicants, completedInterviews, verifiedHires, v] = await Promise.all([
    jobIds.length ? JobApplication.countDocuments({ jobId: { $in: jobIds } }) : 0,
    CareerInterview.countDocuments({ employer: employerId, status: "completed" }),
    CareerOutcome.countDocuments({ employer: employerId, outcomeType: "hired", verificationLevel: "verified" }),
    EmployerCompanyVerification.findOne({ employerUserId: employerId }).select("status companyGroupKey").lean(),
  ]);
  const t = v?.status === "approved" ? await trialOfGroup(v.companyGroupKey) : null;
  const billing = await EmployerHiringBillingEvent.find({ employerUserId: employerId }).select("eventType").lean();
  return {
    jobs: jobIds.length, applicants, completedInterviews, verifiedHires,
    freeHireUsed: !!t && t.consumedCount > 0,
    feeWaivedHires: billing.filter((b) => b.eventType === "free_hire_consumed").length - billing.filter((b) => b.eventType === "free_hire_restored").length,
    hiresPendingPricing: billing.filter((b) => b.eventType === "hire_billable_pending_pricing").length,
    note: "Counted from your jobs' records: applications, interviews recorded as completed, hires you confirmed and the candidate accepted.",
  };
}

// ---------- hooks (after the timeline event commits) ----------
async function approvedGroupOf(employerId) {
  const v = await EmployerCompanyVerification.findOne({ employerUserId: employerId, status: "approved" }).select("companyGroupKey").lean();
  return v?.companyGroupKey || null;
}

/**
 * A hire became verified (HIRE_CONFIRMED). Exactly once per hire event: consume the company's free hire if it
 * has one, else record a hire with pricing pending.
 */
async function onVerifiedHire(event) {
  if (!event?.employer || !flagOn(event.employer)) return { skipped: "flag off" };
  // only a hire the job's employer confirmed counts (an admin can't confirm hires or use a free hire)
  if (event.actorRole && event.actorRole !== "employer") return { skipped: "not confirmed by the employer" };
  return recordHire(event);
}

// the ledger for one verified hire event (HIRE_CONFIRMED, or an admin's HIRE_RESTORED): exactly once per event
async function recordHire(event, { by = event.employer, byRole = "system", reason = "verified hire" } = {}) {
  const key = `hire:${event._id}`;
  const done = await EmployerHiringBillingEvent.findOne({ idempotencyKey: key }).lean();
  if (done) return { billing: done, created: false };
  const groupKey = await approvedGroupOf(event.employer);
  const at = new Date(event.occurredAt || Date.now());
  let trial = null;
  if (groupKey) {
    trial = await EmployerHiringTrial.findOneAndUpdate(
      // only a hire confirmed after the trial was activated can use it
      { companyGroupKey: groupKey, eligibilityStatus: "active", consumedCount: 0, entitlementCount: { $gte: 1 }, createdAt: { $lte: at } },
      {
        $set: { eligibilityStatus: "used", consumedCount: 1, consumedByApplicationId: event.application, consumedByEventId: event._id, consumedAt: at },
        $inc: { version: 1 },
        $push: { history: { action: "consumed", status: "used", by, byRole, reason, applicationId: event.application, at } },
      },
      { returnDocument: "after" }
    ).lean();
  }
  if (groupKey && !trial) {
    // a simultaneous call for this same hire consumed the free hire: its record is on the way, don't
    // record this hire as billable
    const mine = await EmployerHiringTrial.exists({ companyGroupKey: groupKey, consumedByEventId: event._id });
    if (mine) {
      for (let i = 0; i < 40; i++) {
        const rec = await EmployerHiringBillingEvent.findOne({ idempotencyKey: key }).lean();
        if (rec) return { billing: rec, created: false };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { billing: null, created: false };
    }
  }
  const base = { companyGroupKey: groupKey, employerUserId: event.employer, applicationId: event.application, eventId: event._id, policyVersion: POLICY_VERSION, idempotencyKey: key, currency: "PKR", createdAt: at };
  try {
    const billing = trial
      ? (await EmployerHiringBillingEvent.create({ ...base, trialId: trial._id, eventType: "free_hire_consumed", feeWaived: true, amount: 0, note: "first verified hire of the company: fee waived" })).toObject()
      : (await EmployerHiringBillingEvent.create({ ...base, eventType: "hire_billable_pending_pricing", feeWaived: false, amount: null, note: groupKey ? "the free hire is already used or under review" : "no verified company" })).toObject();
    recordSafe(`career.${billing.eventType}`, key, { actor: event.employer, subject: { kind: "JobApplication", id: event.application }, data: { feeWaived: billing.feeWaived } });
    return { billing, created: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // this hire was already decided (e.g. as pending pricing before the trial was restored): keep that
    // decision and give the free hire back
    if (trial) {
      await EmployerHiringTrial.updateOne(
        { _id: trial._id, consumedByEventId: event._id, eligibilityStatus: "used" },
        { $set: { eligibilityStatus: "active", consumedCount: 0, consumedByApplicationId: null, consumedByEventId: null, consumedAt: null }, $inc: { version: 1 }, $pull: { history: { action: "consumed", applicationId: event.application } } }
      );
    }
    return { billing: await EmployerHiringBillingEvent.findOne({ idempotencyKey: key }).lean(), created: false };
  }
}

/**
 * A verified hire was revoked (HIRE_DISPUTED by the candidate, HIRE_REVOKED by an admin). If it used the
 * company's free hire: within 7 days of the hire, the free hire comes back; later, an admin reviews it.
 */
async function onHireRevoked(event) {
  if (!event?.employer || !flagOn(event.employer)) return { skipped: "flag off" };
  // the free hire this revocation undoes: the latest one used BEFORE it (a replay of an old dispute never undoes
  // the free hire a later restore used)
  const consumed = await EmployerHiringBillingEvent.findOne({ applicationId: event.application, eventType: "free_hire_consumed", createdAt: { $lte: new Date(event.occurredAt || Date.now()) } }).sort({ createdAt: -1 }).lean();
  if (!consumed) return { skipped: "not a free hire" };
  const restoreKey = `restore:${consumed.eventId}`;
  if (await EmployerHiringBillingEvent.exists({ idempotencyKey: restoreKey })) return { skipped: "already restored" };
  const trial = await EmployerHiringTrial.findOne({ _id: consumed.trialId, consumedByEventId: consumed.eventId }).lean();
  if (!trial) return { skipped: "trial changed" };
  const at = new Date(event.occurredAt || Date.now());
  const inTime = at.getTime() <= new Date(trial.consumedAt).getTime() + RESTORE_DAYS * DAY;
  if (!inTime) {
    await EmployerHiringTrial.updateOne(
      { _id: trial._id, consumedByEventId: consumed.eventId, eligibilityStatus: "used" },
      { $set: { eligibilityStatus: "under_review", fraudReviewStatus: "open", reviewReason: "the free hire was revoked after the 7-day window" }, $inc: { version: 1 }, $push: { history: { action: "revoked_after_window", status: "under_review", by: null, byRole: "system", reason: event.type, applicationId: event.application, at } } }
    );
    return { underReview: true };
  }
  const restored = await EmployerHiringTrial.findOneAndUpdate(
    { _id: trial._id, consumedByEventId: consumed.eventId },
    {
      $set: { eligibilityStatus: "active", consumedCount: 0, consumedByApplicationId: null, consumedByEventId: null, consumedAt: null },
      $inc: { version: 1 },
      $push: { history: { action: "restored", status: "active", by: null, byRole: "system", reason: `${event.type === "HIRE_DISPUTED" ? "candidate disputed" : "admin revoked"} the hire within 7 days`, applicationId: event.application, at } },
    },
    { returnDocument: "after" }
  ).lean();
  if (!restored) return { skipped: "trial changed" };
  try {
    await EmployerHiringBillingEvent.create({ companyGroupKey: consumed.companyGroupKey, employerUserId: consumed.employerUserId, applicationId: event.application, eventId: event._id, trialId: trial._id, eventType: "free_hire_restored", feeWaived: true, amount: 0, policyVersion: POLICY_VERSION, idempotencyKey: restoreKey, note: `${event.type} within ${RESTORE_DAYS} days`, createdAt: at });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  recordSafe("career.free_hire_restored", restoreKey, { subject: { kind: "EmployerHiringTrial", id: trial._id }, data: { application: String(event.application) } });
  return { restored: true };
}

/** Catch up hires the hooks missed (a crash between the event and the hook): same keys, never twice */
async function reconcile({ companyGroupKey = null, limit = 200 } = {}) {
  const employers = companyGroupKey
    ? (await EmployerCompanyVerification.find({ companyGroupKey, status: "approved" }).select("employerUserId").lean()).map((v) => v.employerUserId)
    : null;
  const filter = { type: { $in: ["HIRE_CONFIRMED", "HIRE_DISPUTED", "HIRE_REVOKED", "HIRE_RESTORED"] }, ...(employers ? { employer: { $in: employers } } : {}) };
  const events = await CareerApplicationEvent.find(filter).sort({ occurredAt: 1 }).limit(limit).lean();
  // never reach back: only hires after the employer's company was approved (a hire confirmed before the pilot
  // or before approval is not part of the programme)
  const approvedAt = new Map((await EmployerCompanyVerification.find({ employerUserId: { $in: [...new Set(events.map((e) => String(e.employer)))] }, status: "approved" }).select("employerUserId reviewedAt").lean()).map((v) => [String(v.employerUserId), v.reviewedAt]));
  let processed = 0;
  for (const e of events) {
    if (!flagOn(e.employer)) continue;
    const since = approvedAt.get(String(e.employer));
    if (!since || new Date(e.occurredAt) < new Date(since)) continue;
    if (e.type === "HIRE_CONFIRMED") {
      if (!(await EmployerHiringBillingEvent.exists({ idempotencyKey: `hire:${e._id}` }))) { await onVerifiedHire(e); processed += 1; }
    } else if (e.type === "HIRE_RESTORED") {
      if ((await onHireRestored(e)).created) processed += 1;
    } else {
      const r = await onHireRevoked(e);
      if (r.restored || r.underReview) processed += 1;
    }
  }
  return processed;
}

/**
 * An admin rejected the candidate's dispute: the hire is verified again and counts again, exactly once. It uses the
 * free hire if the company's trial is active and unused, else it is billable with pricing pending; nothing new if
 * this hire still holds its free hire or a pending row (never counted twice). Audited with the admin's reason.
 */
async function onHireRestored(event) {
  if (!event?.employer || !flagOn(event.employer)) return { skipped: "flag off" };
  if (event.actorRole !== "admin") return { skipped: "not an admin restore" };
  if (await EmployerHiringBillingEvent.exists({ idempotencyKey: `hire:${event._id}` })) return { skipped: "already recorded" };
  const rows = await EmployerHiringBillingEvent.find({ applicationId: event.application }).select("eventType").lean();
  const n = (t) => rows.filter((r) => r.eventType === t).length;
  if (n("free_hire_consumed") - n("free_hire_restored") > 0 || n("hire_billable_pending_pricing") > 0) return { skipped: "already counted" };
  const reason = String(event.metadata?.note || "dispute rejected").slice(0, 500);
  const out = await recordHire(event, { by: event.actor, byRole: "admin", reason: `hire restored: ${reason}` });
  // audited on the company's trial (a company without one has no First Hire Free to account for; the timeline
  // event itself records the admin and the reason)
  const trialId = out.billing?.trialId || (out.billing?.companyGroupKey && (await EmployerHiringTrial.findOne({ companyGroupKey: out.billing.companyGroupKey }).select("_id").lean())?._id);
  if (out.created && out.billing && trialId) {
    const free = out.billing.eventType === "free_hire_consumed";
    await audit(event.actor, free ? "trial.restored_hire_used_free_hire" : "trial.restored_hire_pending_pricing", "EmployerHiringTrial", { _id: trialId }, reason,
      { applicationId: String(event.application) }, { eventType: out.billing.eventType, feeWaived: out.billing.feeWaived, amount: out.billing.amount });
  }
  return out;
}

timeline.onEvent(async (event) => {
  if (event.type === "HIRE_CONFIRMED") await onVerifiedHire(event);
  else if (event.type === "HIRE_RESTORED") await onHireRestored(event);
  else if (event.type === "HIRE_DISPUTED" || event.type === "HIRE_REVOKED") await onHireRevoked(event);
});

// ---------- admin ----------
const audit = (admin, action, targetType, target, reason, before, after) =>
  CareerAdminAudit.create({ admin, action, targetType, targetId: target._id, reason, before, after });
const needReason = (reason) => {
  const r = String(reason || "").trim();
  if (r.length < 3) throw new CareerError(400, "REASON_REQUIRED", "Write the reason for this decision");
  return r.slice(0, 500);
};

/** approve | reject | mark_duplicate (reason required). approve with separateGroup: its own company group */
async function reviewVerification(adminId, id, { action, reason, separateGroup = false }, now = new Date()) {
  const r = needReason(reason);
  if (!["approve", "reject", "mark_duplicate"].includes(action)) throw new CareerError(400, "INVALID_ACTION", "action must be approve, reject or mark_duplicate");
  const v = isId(id) ? await EmployerCompanyVerification.findById(id).lean() : null;
  if (!v) throw new CareerError(404, "NOT_FOUND", "Verification not found");
  const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "duplicate_review";
  const set = { status, reviewedBy: adminId, reviewedAt: now, reason: r };
  if (action === "approve" && separateGroup) {
    const sameReg = await EmployerCompanyVerification.exists({ _id: { $ne: v._id }, ntnOrSecp: v.ntnOrSecp, status: "approved" });
    if (sameReg) throw new CareerError(409, "SAME_REGISTRATION", "Another approved account has the same registration number: it's the same company");
    set.companyGroupKey = `reg:${v.ntnOrSecp}`;
  }
  const updated = await EmployerCompanyVerification.findOneAndUpdate(
    { _id: v._id, updatedAt: v.updatedAt },
    { $set: set, $push: { history: { action, status, by: adminId, byRole: "admin", reason: r, at: now } } },
    { returnDocument: "after" }
  ).lean();
  if (!updated) throw new CareerError(409, "STALE", "This changed meanwhile; reload and try again");
  await audit(adminId, `verification.${action}`, "EmployerCompanyVerification", v, r, { status: v.status, companyGroupKey: v.companyGroupKey }, { status: updated.status, companyGroupKey: updated.companyGroupKey });
  return updated;
}

/** restore | revoke | keep (reason required) */
async function reviewTrial(adminId, id, { action, reason }, now = new Date()) {
  const r = needReason(reason);
  if (!["restore", "revoke", "keep"].includes(action)) throw new CareerError(400, "INVALID_ACTION", "action must be restore, revoke or keep");
  const t = isId(id) ? await EmployerHiringTrial.findById(id).lean() : null;
  if (!t) throw new CareerError(404, "NOT_FOUND", "Trial not found");
  let set;
  if (action === "restore") set = { eligibilityStatus: "active", entitlementCount: 1, consumedCount: 0, consumedByApplicationId: null, consumedByEventId: null, consumedAt: null, fraudReviewStatus: t.fraudReviewStatus === "none" ? "none" : "cleared", reviewReason: r };
  else if (action === "revoke") set = { eligibilityStatus: "used", entitlementCount: 0, fraudReviewStatus: "revoked", reviewReason: r };
  else set = { eligibilityStatus: t.consumedCount > 0 || t.entitlementCount === 0 ? "used" : "active", fraudReviewStatus: t.fraudReviewStatus === "none" ? "none" : "cleared", reviewReason: r };
  const updated = await EmployerHiringTrial.findOneAndUpdate(
    { _id: t._id, version: t.version },
    { $set: set, $inc: { version: 1 }, $push: { history: { action: `admin_${action}`, status: set.eligibilityStatus, by: adminId, byRole: "admin", reason: r, applicationId: t.consumedByApplicationId, at: now } } },
    { returnDocument: "after" }
  ).lean();
  if (!updated) throw new CareerError(409, "STALE", "This trial changed meanwhile; reload and try again");
  if (action === "restore" && t.consumedCount > 0) {
    await EmployerHiringBillingEvent.create({
      companyGroupKey: t.companyGroupKey, employerUserId: t.activatedBy, applicationId: t.consumedByApplicationId, trialId: t._id,
      eventType: "free_hire_restored", feeWaived: true, amount: 0, policyVersion: POLICY_VERSION, note: `restored by an admin: ${r}`,
      idempotencyKey: `admin-restore:${t._id}:${t.version}`, createdAt: now,
    });
  }
  await audit(adminId, `trial.${action}`, "EmployerHiringTrial", t, r, { eligibilityStatus: t.eligibilityStatus, consumedCount: t.consumedCount, entitlementCount: t.entitlementCount }, { eligibilityStatus: updated.eligibilityStatus, consumedCount: updated.consumedCount, entitlementCount: updated.entitlementCount });
  return updated;
}

module.exports = {
  POLICY_VERSION, POLICY_TEXT, RESTORE_DAYS, flagOn, pilotConfigured, cleanDetails, normalizeRegistration, freeMail, hostOf,
  submitVerification, activate, viewFor, summaryFor, onVerifiedHire, onHireRevoked, onHireRestored, reconcile, reviewVerification, reviewTrial, trialOfGroup,
};

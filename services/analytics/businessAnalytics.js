// services/analytics/businessAnalytics.js
// Business analytics, counted only from authoritative records (plan section 7). Every number says what it
// counts and over which denominator; every card has a date range. Never counted:
//   - a claim or a QR code as a redemption (only Offer.redemptions + RedemptionArchive: brand-confirmed bills)
//   - a hold or a view as a Surprise Box order; an order as picked up without the pickup code being verified
//   - an application or a scheduled interview as a hire (the hiring funnel comes from timeline events)
//   - a trial signup as revenue (there is no pricing yet: paying employers = 0)
//   - a Resume Studio request as completed, or a draft as approved (only succeeded jobs / approved versions)
// Privacy: no student names anywhere; any per-brand or per-employer figure built from fewer than 5 distinct
// students is hidden (null, with a note).
const Offer = require("../../models/Offer");
const RedemptionArchive = require("../../models/RedemptionArchive");
const LoyaltyLedger = require("../../models/LoyaltyLedger");
const SurplusOrder = require("../../models/SurplusOrder");
const User = require("../../models/User");
const EmployerCompanyVerification = require("../../models/EmployerCompanyVerification");
const EmployerHiringTrial = require("../../models/EmployerHiringTrial");
const EmployerHiringBillingEvent = require("../../models/EmployerHiringBillingEvent");
const careerAnalytics = require("../career/careerAnalyticsService");
const CareerResumeTailorJob = require("../../models/CareerResumeTailorJob");
const CareerResumeDraft = require("../../models/CareerResumeDraft");
const CareerResumeApprovedVersion = require("../../models/CareerResumeApprovedVersion");
const CareerApplicationResumeAttachment = require("../../models/CareerApplicationResumeAttachment");

const MIN_COHORT = 5;
const DAY = 864e5;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const sum = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const same = (a, b) => String(a) === String(b);
const inRange = (d, r) => d && new Date(d) >= r.from && new Date(d) <= r.to;
const hidden = (n) => n < MIN_COHORT;
const HIDDEN_NOTE = `hidden: fewer than ${MIN_COHORT} students`;

/** from / to (ISO dates or YYYY-MM-DD); default the last 30 days; at most 366 days */
function rangeOf(q = {}) {
  const to = q.to ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? `${q.to}T23:59:59.999+05:00` : q.to) : new Date();
  const from = q.from ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(q.from) ? `${q.from}T00:00:00+05:00` : q.from) : new Date(to.getTime() - 30 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw Object.assign(new Error("from / to must be dates, from before to"), { status: 400, code: "INVALID_RANGE" });
  if (to - from > 366 * DAY) throw Object.assign(new Error("the range can be at most a year"), { status: 400, code: "RANGE_TOO_LONG" });
  return { from, to };
}

// ---------- discounts: brand-confirmed redemptions ----------
async function redemptionsIn(r, brandId = null) {
  const offers = await Offer.find({ ...(brandId ? { brand: brandId } : {}), "redemptions.redeemedAt": { $gte: r.from, $lte: r.to } }).select("brand redemptions").lean();
  const rows = [];
  for (const o of offers) for (const x of o.redemptions || []) if (inRange(x.redeemedAt, r)) rows.push({ brand: String(o.brand), student: String(x.student), bill: x.billAmount || 0, saved: x.savedAmount || 0, at: x.redeemedAt });
  return rows;
}
function discountFigures(rows) {
  const students = new Set(rows.map((x) => x.student));
  const perStudentBrand = new Map();
  for (const x of rows) perStudentBrand.set(`${x.brand}:${x.student}`, (perStudentBrand.get(`${x.brand}:${x.student}`) || 0) + 1);
  const pairs = [...perStudentBrand.values()];
  const repeatPairs = pairs.filter((n) => n >= 2).length;
  return {
    redemptions: rows.length, uniqueStudents: students.size,
    billTotal: sum(rows, (x) => x.bill), savedTotal: sum(rows, (x) => x.saved),
    repeatCustomers: repeatPairs, studentBrandPairs: pairs.length, repeatRatePct: pct(repeatPairs, pairs.length),
  };
}

async function discountsAdmin(r) {
  const live = await redemptionsIn(r);
  const archived = (await RedemptionArchive.find({ kind: "redemption", redeemedAt: { $gte: r.from, $lte: r.to } }).select("student billAmount savedAmount redeemedAt").lean())
    .map((x) => ({ brand: "deleted", student: String(x.student), bill: x.billAmount || 0, saved: x.savedAmount || 0, at: x.redeemedAt }));
  const f = discountFigures([...live, ...archived]);
  // per brand: only brands with at least MIN_COHORT distinct students
  const byBrand = new Map();
  for (const x of live) {
    const b = byBrand.get(x.brand) || { rows: [] };
    b.rows.push(x);
    byBrand.set(x.brand, b);
  }
  const names = new Map((await User.find({ _id: { $in: [...byBrand.keys()] } }).select("brandName companyName name").lean()).map((u) => [String(u._id), u.brandName || u.companyName || u.name || "brand"]));
  const brands = [...byBrand.entries()].map(([id, b]) => ({ id, name: names.get(id) || "brand", ...discountFigures(b.rows) }));
  return {
    ...f, archivedRedemptions: archived.length,
    definitions: { redemptions: "bills the brand confirmed (QR / promo verify, store orders); claims are not redemptions", repeatRatePct: "student-brand pairs with 2+ redemptions / all student-brand pairs", archived: "redemptions of deleted brands (kept for totals, no brand)" },
    topBrands: brands.filter((b) => !hidden(b.uniqueStudents)).sort((a, b) => b.redemptions - a.redemptions).slice(0, 10),
    brandsHidden: brands.filter((b) => hidden(b.uniqueStudents)).length,
  };
}

// ---------- loyalty: the ledger ----------
async function loyaltyFigures(r, brandId = null) {
  const rows = await LoyaltyLedger.find({ ...(brandId ? { brand: brandId } : {}), effectiveAt: { $gte: r.from, $lte: r.to } }).select("brand student type visitsDelta tierName visitNumber").lean();
  const credits = rows.filter((x) => x.type === "CREDIT");
  const counted = credits.filter((x) => x.visitsDelta > 0);
  const reversals = rows.filter((x) => x.type === "REVERSAL" && x.visitsDelta < 0);
  const members = new Set(counted.map((x) => `${x.brand}:${x.student}`));
  // the tier each member reached (their highest counted visit in the range)
  const best = new Map();
  for (const x of counted) {
    const k = `${x.brand}:${x.student}`;
    if (!best.has(k) || (x.visitNumber || 0) > (best.get(k).visitNumber || 0)) best.set(k, x);
  }
  const tiers = {};
  for (const x of best.values()) tiers[x.tierName || "member"] = (tiers[x.tierName || "member"] || 0) + 1;
  const students = new Set(counted.map((x) => String(x.student)));
  return {
    countedVisits: counted.length, creditsNotCounted: credits.length - counted.length, reversals: reversals.length,
    netVisits: counted.length - reversals.length, members: members.size, uniqueStudents: students.size,
    membersByTier: hidden(students.size) ? null : tiers, membersByTierNote: hidden(students.size) ? HIDDEN_NOTE : "",
    definitions: { countedVisits: "loyalty credits that counted as a visit (each tied to a brand-confirmed redemption)", reversals: "credits reversed by an admin (refund, void, fraud)" },
  };
}

// ---------- surprise box: orders ----------
async function surplusFigures(r, brandId = null) {
  const orders = await SurplusOrder.find({ ...(brandId ? { brand: brandId } : {}), createdAt: { $gte: r.from, $lte: r.to } }).select("state qty priceSnapshot paymentState pickupCodeUsedAt stateBeforeDispute student").lean();
  const was = (o, s) => o.state === s || o.stateBeforeDispute === s;
  const picked = orders.filter((o) => !!o.pickupCodeUsedAt);
  const cancelled = orders.filter((o) => was(o, "CUSTOMER_CANCELLED") || was(o, "MERCHANT_CANCELLED"));
  const due = orders.length - cancelled.length; // orders that should have been collected
  return {
    ordersPlaced: orders.length, boxesOrdered: sum(orders, (o) => o.qty),
    verifiedPickups: picked.length, boxesPickedUp: sum(picked, (o) => o.qty),
    collectedAtPickup: sum(orders.filter((o) => o.paymentState === "paid_at_pickup"), (o) => o.priceSnapshot?.total),
    cancelledByStudent: orders.filter((o) => was(o, "CUSTOMER_CANCELLED")).length, cancelledByBrand: orders.filter((o) => was(o, "MERCHANT_CANCELLED")).length,
    noShows: orders.filter((o) => was(o, "NO_SHOW")).length, disputes: orders.filter((o) => o.state === "DISPUTED").length,
    pickupRatePct: pct(picked.length, due), pickupRateDenominator: due,
    definitions: { ordersPlaced: "confirmed orders (holds and views are not orders)", verifiedPickups: "orders whose pickup code the brand verified", collectedAtPickup: "money the brand marked as paid at pickup (tdc takes no money)", pickupRatePct: "verified pickups / orders not cancelled" },
  };
}

// ---------- employers: first hire free + ledger ----------
async function employerFigures(r) {
  const [verifs, trials, billing] = await Promise.all([
    EmployerCompanyVerification.find({}).select("status").lean(),
    EmployerHiringTrial.find({}).select("eligibilityStatus createdAt").lean(),
    EmployerHiringBillingEvent.find({ createdAt: { $gte: r.from, $lte: r.to } }).select("eventType").lean(),
  ]);
  const by = (xs, k, v) => xs.filter((x) => x[k] === v).length;
  const consumed = by(billing, "eventType", "free_hire_consumed");
  const restored = by(billing, "eventType", "free_hire_restored");
  return {
    companiesVerified: by(verifs, "status", "approved"), verificationsPending: by(verifs, "status", "pending"), suspectedDuplicates: by(verifs, "status", "duplicate_review"), verificationsRejected: by(verifs, "status", "rejected"),
    trialsIssued: trials.length, trialsIssuedInRange: trials.filter((t) => inRange(t.createdAt, r)).length,
    trialsActive: by(trials, "eligibilityStatus", "active"), trialsUsed: by(trials, "eligibilityStatus", "used"), trialsUnderReview: by(trials, "eligibilityStatus", "under_review"),
    freeHiresConsumed: consumed, freeHiresRestored: restored, netFreeHires: consumed - restored,
    hiresPendingPricing: by(billing, "eventType", "hire_billable_pending_pricing"),
    payingEmployers: 0, feesCollected: 0, trialToPaidPct: null,
    definitions: { payingEmployers: "no pricing exists yet: nobody pays and nothing is charged", hiresPendingPricing: "verified hires after a company's free hire, recorded for when pricing exists (amount empty)", freeHiresConsumed: "fee-waived verified hires in the range (ledger)" },
  };
}

// ---------- Resume Studio: tailoring jobs, drafts, approved versions, attachments ----------
// the value at a percentile of an ascending list (nearest rank), or null for an empty list
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null);
async function resumeStudioFigures(r) {
  const [jobs, drafts, versions, attachments] = await Promise.all([
    CareerResumeTailorJob.find({ createdAt: { $gte: r.from, $lte: r.to } }).select("userId status errorCode createdAt finishedAt").lean(),
    CareerResumeDraft.find({ createdAt: { $gte: r.from, $lte: r.to } }).select("suggestions.status suggestions.decision").lean(),
    CareerResumeApprovedVersion.find({ approvedAt: { $gte: r.from, $lte: r.to } }).select("userId").lean(),
    CareerApplicationResumeAttachment.find({ attachedAt: { $gte: r.from, $lte: r.to } }).select("applicationId").lean(),
  ]);
  const succeeded = jobs.filter((j) => j.status === "succeeded");
  const failed = jobs.filter((j) => j.status === "failed");
  const failedBy = {};
  for (const j of failed) failedBy[j.errorCode || "UNKNOWN"] = (failedBy[j.errorCode || "UNKNOWN"] || 0) + 1;
  const seconds = succeeded.filter((j) => j.finishedAt).map((j) => Math.max(0, (new Date(j.finishedAt) - new Date(j.createdAt)) / 1000)).sort((a, b) => a - b);
  const suggestions = drafts.flatMap((d) => d.suggestions || []);
  const blocked = suggestions.filter((s) => s.status === "blocked").length;
  return {
    tailoringStarted: jobs.length, tailoringCompleted: succeeded.length, tailoringFailed: failed.length, failedByReason: failedBy,
    inProgress: jobs.length - succeeded.length - failed.length,
    studentsTailoring: new Set(jobs.map((j) => String(j.userId))).size,
    approvals: versions.length, studentsApproved: new Set(versions.map((v) => String(v.userId))).size,
    applicationsWithTailoredVersion: attachments.length,
    suggestions: suggestions.length, factualCheckRejections: blocked,
    factualCheckRejectionPct: pct(blocked, suggestions.length),
    needsConfirmation: suggestions.filter((s) => s.status === "needs_user_confirmation").length,
    timeToDraftSeconds: { p50: percentile(seconds, 50), p95: percentile(seconds, 95), count: seconds.length },
    definitions: {
      tailoringStarted: "tailoring requests made in the range (requests are kept 30 days, so older ranges undercount)",
      tailoringCompleted: "requests that produced a draft; failed ones are listed by reason (TIMED_OUT, model errors)",
      approvals: "tailored versions students approved in the range",
      applicationsWithTailoredVersion: "applications sent with an approved tailored version (attached in the range)",
      factualCheckRejections: "suggested changes the factual check blocked (a fact, date, number or link not in the student's resume), in drafts created in the range",
      needsConfirmation: "suggested changes shown only if the student confirms they are true",
      timeToDraftSeconds: "from the request to the finished draft, completed requests only (p50 = median)",
    },
  };
}

async function adminOverview(q) {
  const r = rangeOf(q);
  const [discounts, loyalty, surplus, hiring, employers, resumeStudio] = await Promise.all([
    discountsAdmin(r), loyaltyFigures(r), surplusFigures(r), careerAnalytics.funnel({ from: r.from, to: r.to }), employerFigures(r), resumeStudioFigures(r),
  ]);
  return { range: r, minCohort: MIN_COHORT, discounts, loyalty, surpriseBox: surplus, hiring, employers, resumeStudio };
}

async function brandInsights(brandId, q) {
  const r = rangeOf(q);
  const rows = await redemptionsIn(r, brandId);
  const f = discountFigures(rows);
  const small = hidden(f.uniqueStudents);
  return {
    range: r, minCohort: MIN_COHORT,
    discounts: {
      redemptions: f.redemptions, uniqueStudents: small ? null : f.uniqueStudents, billTotal: f.billTotal, savedTotal: f.savedTotal,
      repeatCustomers: small ? null : f.repeatCustomers, repeatRatePct: small ? null : f.repeatRatePct, note: small ? HIDDEN_NOTE : "",
      definitions: { repeatCustomers: "students with 2+ confirmed redemptions at your brand in the range", repeatRatePct: "repeat customers / students who redeemed" },
    },
    loyalty: await loyaltyFigures(r, brandId),
    surpriseBox: await surplusFigures(r, brandId),
  };
}

async function employerResults(employerId, q, { trialService = null } = {}) {
  const r = rangeOf(q);
  const hiring = await careerAnalytics.funnel({ employerId, from: r.from, to: r.to });
  const out = { range: r, hiring, trial: null };
  if (trialService && trialService.flagOn(employerId)) {
    const v = await trialService.viewFor(employerId);
    out.trial = { status: v.status, remainingFreeHires: v.remainingFreeHires, nextAction: v.nextAction, summary: await trialService.summaryFor(employerId), furtherHires: v.policy.furtherHires };
  }
  return out;
}

module.exports = { adminOverview, brandInsights, employerResults, rangeOf, MIN_COHORT, discountFigures, resumeStudioFigures, percentile };

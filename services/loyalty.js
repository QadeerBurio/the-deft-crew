// services/loyalty.js
// Brand loyalty: verified visits → tiers → the discount a student's next visit gets.
//
// - A visit is one brand-confirmed redemption (redeem-payment, promo verify / confirm-redemption, or a
//   verified Woo / Shopify order). Claims, QR codes and views never count.
// - onVerifiedRedemption(redemptionId) is the only way a visit is credited. The callers are the existing
//   verified-redemption paths, after their own atomic success; it reads everything (student, brand,
//   offer, bill) back from the redemption itself, never from the request. Exactly one ledger row per
//   redemption (unique idempotency key + a per-redemption guard), however often or simultaneously it runs.
// - Visits = counted credits − reversals, within the program's reset window. A reversal appends a row;
//   nothing is edited or deleted. LoyaltySnapshot is a cache rebuilt from the ledger.
// - Loyalty applies only where FLAG_LOYALTY_V2 is on for BOTH the brand and the student, and the brand
//   has an active program covering the offer (and branch, if the program names branches).
const mongoose = require("mongoose");
const LoyaltyProgram = require("../models/LoyaltyProgram");
const LoyaltyLedger = require("../models/LoyaltyLedger");
const LoyaltySnapshot = require("../models/LoyaltySnapshot");
const Offer = require("../models/Offer");
const Branch = require("../models/Branch");
const { isEnabled } = require("../config/featureFlags");
const { recordSafe } = require("./domainEvents");
const { takeSlot, releaseSlot } = require("../models/RedemptionGuard");
const { withTransaction } = require("../utils/transaction");
const { dayKey } = require("../utils/karachiTime");

const DEFAULT_TIERS = [
  { name: "Member", minVisit: 1, maxVisit: 5, discountPct: 15 },
  { name: "Regular", minVisit: 6, maxVisit: null, discountPct: 25 },
];
const STATUSES = ["draft", "active", "paused", "ended"];
const DAY_MS = 24 * 60 * 60 * 1000;

class LoyaltyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const same = (a, b) => String(a) === String(b);

// ---------- flag ----------
function enabledFor(brandId, studentId) {
  return isEnabled("loyaltyV2", { id: String(brandId), role: "brand" }) && isEnabled("loyaltyV2", { id: String(studentId), role: "student" });
}

// ---------- rules ----------
const capOf = (program) => Math.min(Number(program.maxDiscountPct ?? 100), program.adminMaxDiscountPct == null ? 100 : Number(program.adminMaxDiscountPct));

// tiers: contiguous from visit 1, last one open-ended, each % within the cap
function validateTiers(tiers, cap = 100) {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 10) throw new LoyaltyError(400, "INVALID_TIERS", "Give 1 to 10 tiers");
  const out = tiers
    .map((t) => ({
      name: String(t?.name || "").trim().slice(0, 40),
      minVisit: Number(t?.minVisit),
      maxVisit: t?.maxVisit == null || t?.maxVisit === "" ? null : Number(t.maxVisit),
      discountPct: Number(t?.discountPct),
    }))
    .sort((a, b) => a.minVisit - b.minVisit);
  out.forEach((t, i) => {
    const where = `Tier ${i + 1}`;
    if (!Number.isInteger(t.minVisit) || t.minVisit < 1) throw new LoyaltyError(400, "INVALID_TIERS", `${where}: the first visit must be a whole number from 1`);
    if (t.maxVisit !== null && (!Number.isInteger(t.maxVisit) || t.maxVisit < t.minVisit)) throw new LoyaltyError(400, "INVALID_TIERS", `${where}: the last visit must be a whole number, not before the first`);
    if (!Number.isFinite(t.discountPct) || t.discountPct <= 0 || t.discountPct > 100) throw new LoyaltyError(400, "INVALID_TIERS", `${where}: the discount must be more than 0 and at most 100%`);
    if (t.discountPct > cap) throw new LoyaltyError(400, "OVER_MAX_DISCOUNT", `${where}: ${t.discountPct}% is over the maximum discount (${cap}%)`);
    if (i === 0 && t.minVisit !== 1) throw new LoyaltyError(400, "INVALID_TIERS", "The first tier must start at visit 1");
    if (i > 0 && t.minVisit !== out[i - 1].maxVisit + 1) throw new LoyaltyError(400, "INVALID_TIERS", `${where} must start right after tier ${i} (no gaps or overlaps)`);
    if (i < out.length - 1 && t.maxVisit === null) throw new LoyaltyError(400, "INVALID_TIERS", `Only the last tier can be open-ended`);
    if (!t.name) t.name = `Tier ${i + 1}`;
  });
  if (out[out.length - 1].maxVisit !== null) throw new LoyaltyError(400, "INVALID_TIERS", "The last tier must have no end (every later visit)");
  return out;
}

const tierFor = (tiers, visitNumber) => tiers.find((t) => t.minVisit <= visitNumber && (t.maxVisit == null || visitNumber <= t.maxVisit)) || tiers[tiers.length - 1];
const pctOf = (program, tier) => Math.min(Number(tier.discountPct), capOf(program));

// where a student stands: visits so far, and what the next visit gets
function progressOf(program, visits) {
  const nextVisitNumber = visits + 1;
  const current = tierFor(program.tiers, nextVisitNumber);
  const next = program.tiers.find((t) => t.minVisit > nextVisitNumber) || null;
  return {
    visits,
    nextVisitNumber,
    currentTier: { name: current.name, discountPct: pctOf(program, current) },
    nextTier: next ? { name: next.name, minVisit: next.minVisit, discountPct: pctOf(program, next) } : null,
    // more visits needed before a visit gets the next tier's discount
    visitsBeforeNextTier: next ? next.minVisit - nextVisitNumber : null,
  };
}

// the public view of a program (what students and the brand portal read)
function publicProgram(p) {
  return {
    id: String(p._id),
    brand: String(p.brand),
    status: p.status,
    version: p.version,
    tiers: p.tiers.map((t) => ({ name: t.name, minVisit: t.minVisit, maxVisit: t.maxVisit, discountPct: pctOf(p, t) })),
    maxDiscountPct: capOf(p),
    eligibleOfferIds: (p.eligibleOfferIds || []).map(String),
    branchIds: (p.branchIds || []).map(String),
    maxVisitsPerDay: p.maxVisitsPerDay,
    resetMonths: p.resetMonths,
    terms: p.terms || "",
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  };
}

const running = (p, now = new Date()) => p && p.status === "active" && (!p.startsAt || new Date(p.startsAt) <= now) && (!p.endsAt || now <= new Date(p.endsAt));
async function activeProgram(brandId, now = new Date()) {
  if (!isId(brandId)) return null;
  const p = await LoyaltyProgram.findOne({ brand: brandId, status: "active" }).lean();
  return running(p, now) ? p : null;
}
const offerCovered = (p, offerId) => !(p.eligibleOfferIds || []).length || p.eligibleOfferIds.some((o) => same(o, offerId));
const branchCovered = (p, branchId) => !(p.branchIds || []).length || (!!branchId && p.branchIds.some((b) => same(b, branchId)));

// ---------- visits, from the ledger ----------
function windowStart(program, now = new Date()) {
  if (!program.resetMonths) return null;
  const d = new Date(now);
  d.setMonth(d.getMonth() - Number(program.resetMonths));
  return d;
}

function tally(entries, program, now = new Date()) {
  const from = windowStart(program, now);
  const reversed = new Set(entries.filter((e) => e.type === "REVERSAL" && e.reverses).map((e) => String(e.reverses)));
  const counted = entries.filter((e) => e.type === "CREDIT" && e.visitsDelta > 0 && !reversed.has(String(e._id)));
  const inWindow = counted.filter((e) => !from || new Date(e.effectiveAt) >= from);
  const today = dayKey(now);
  return {
    visits: inWindow.reduce((n, e) => n + e.visitsDelta, 0),
    visitsToday: counted.filter((e) => dayKey(new Date(e.effectiveAt)) === today).length,
  };
}

const ledgerOf = (brandId, studentId) => LoyaltyLedger.find({ brand: brandId, student: studentId }).sort({ effectiveAt: 1 }).lean();

async function rebuildSnapshot(program, brandId, studentId, session = null) {
  const entries = await LoyaltyLedger.find({ brand: brandId, student: studentId }).session(session).lean();
  const { visits } = tally(entries, program);
  const pr = progressOf(program, visits);
  await LoyaltySnapshot.updateOne(
    { brand: brandId, student: studentId },
    { $set: { program: program._id, visits, tierName: pr.currentTier.name, discountPct: pr.currentTier.discountPct, computedAt: new Date() } },
    { upsert: true, session }
  );
  return pr;
}

// ---------- the student's standing (GET /brands/:brandId/me) ----------
async function standing(brandId, studentId) {
  if (!enabledFor(brandId, studentId)) return { enabled: false, reason: "not-enabled" };
  const program = await activeProgram(brandId);
  if (!program) return { enabled: false, reason: "no-program" };
  const { visits } = tally(await ledgerOf(brandId, studentId), program);
  return { enabled: true, program: publicProgram(program), progress: progressOf(program, visits) };
}

// ---------- quote: what this visit gets (brand side, before confirming) ----------
async function quoteFor({ brandId, studentId, offerId, branchId = null }) {
  const no = (reason) => ({ applies: false, reason });
  if (!isId(brandId) || !isId(studentId)) return no("invalid");
  if (!enabledFor(brandId, studentId)) return no("not-enabled");
  const program = await activeProgram(brandId);
  if (!program) return no("no-program");
  if (offerId && !offerCovered(program, offerId)) return no("offer-not-in-program");
  if (!branchCovered(program, branchId)) return no("branch-not-in-program");
  const { visits, visitsToday } = tally(await ledgerOf(brandId, studentId), program);
  const pr = progressOf(program, visits);
  const countsAsVisit = !program.maxVisitsPerDay || visitsToday < program.maxVisitsPerDay;
  return {
    applies: true,
    programId: String(program._id),
    programVersion: program.version,
    ...pr,
    discountPct: pr.currentTier.discountPct,
    tierName: pr.currentTier.name,
    countsAsVisit, // false: the daily visit limit is reached; the discount still applies
    reason: countsAsVisit ? "" : "daily-limit",
  };
}

// ---------- the hook ----------
// opts: { source, branchId, actor, discountPct } — discountPct: the loyalty % the caller applied (null: none)
async function onVerifiedRedemption(redemptionId, opts = {}) {
  const none = (reason, extra = {}) => ({ credited: false, reason, ...extra });
  if (!isId(redemptionId)) return none("invalid");
  const offer = await Offer.findOne({ "redemptions._id": redemptionId }).select("brand redemptions").lean();
  const r = offer && (offer.redemptions || []).find((x) => same(x._id, redemptionId));
  if (!r || !r.student) return none("no-redemption");
  const brandId = offer.brand;
  const studentId = r.student;
  if (!enabledFor(brandId, studentId)) return none("not-enabled");
  const program = await activeProgram(brandId);
  if (!program) return none("no-program");
  if (!offerCovered(program, offer._id)) return none("offer-not-in-program");
  if (!branchCovered(program, opts.branchId)) return none("branch-not-in-program");

  const key = `credit:${redemptionId}`;
  const existing = await LoyaltyLedger.findOne({ idempotencyKey: key }).lean();
  if (existing) return { credited: existing.visitsDelta > 0, duplicate: true, entry: existing };
  // one writer per redemption: simultaneous calls for the same redemption → one proceeds
  const lockKey = `loyalty-credit:${redemptionId}`;
  if (!(await takeSlot(lockKey, 1, 0, new Date(Date.now() + 30 * DAY_MS)))) {
    return { credited: false, duplicate: true, entry: await LoyaltyLedger.findOne({ idempotencyKey: key }).lean() };
  }
  let dayKeyTaken = null;
  try {
    const entries = await ledgerOf(brandId, studentId);
    const { visits, visitsToday } = tally(entries, program);
    let counts = true;
    if (program.maxVisitsPerDay) {
      const k = `loyalty-day:${program._id}:${studentId}:${dayKey()}`;
      counts = await takeSlot(k, program.maxVisitsPerDay, visitsToday, new Date(Date.now() + 3 * DAY_MS));
      if (counts) dayKeyTaken = k;
    }
    const tier = tierFor(program.tiers, visits + 1);
    const row = {
      program: program._id,
      programVersion: program.version,
      brand: brandId,
      student: studentId,
      type: "CREDIT",
      visitsDelta: counts ? 1 : 0,
      redemptionId,
      offer: offer._id,
      branch: isId(opts.branchId) ? opts.branchId : null,
      source: String(opts.source || ""),
      reason: counts ? "" : "daily-limit",
      visitNumber: counts ? visits + 1 : null,
      tierName: tier.name,
      discountPct: opts.discountPct == null ? null : Number(opts.discountPct),
      billAmount: Number(r.billAmount) || null,
      savedAmount: Number(r.savedAmount) || null,
      actor: isId(opts.actor) ? opts.actor : null,
      idempotencyKey: key,
      effectiveAt: new Date(),
    };
    const { result } = await withTransaction(async (session) => {
      const [entry] = await LoyaltyLedger.create([row], { session });
      const progress = await rebuildSnapshot(program, brandId, studentId, session);
      return { entry: entry.toObject(), progress };
    });
    if (counts) {
      await recordSafe("loyalty.credited", String(redemptionId), {
        actor: row.actor, subject: { kind: "LoyaltyLedger", id: result.entry._id },
        data: { brand: String(brandId), student: String(studentId), visitNumber: row.visitNumber, tier: tier.name, source: row.source },
      });
      // push + in-app, once per ledger row (services/loyaltyNotify.js); never fails the credit
      await require("./loyaltyNotify").notifyRow(result.entry, result.progress, { thisVisitPct: pctOf(program, tier) });
    }
    return { credited: counts, reason: row.reason, visitNumber: row.visitNumber, entry: result.entry, progress: result.progress };
  } catch (err) {
    if (dayKeyTaken) await releaseSlot(dayKeyTaken);
    if (err?.code === 11000) return { credited: false, duplicate: true, entry: await LoyaltyLedger.findOne({ idempotencyKey: key }).lean() };
    await releaseSlot(lockKey); // nothing written: a retry may try again
    throw err;
  }
}

// a caller's safe wrapper: a loyalty failure never fails the redemption it follows
async function creditSafe(redemptionId, opts) {
  try {
    return await onVerifiedRedemption(redemptionId, opts);
  } catch (err) {
    console.error(`[loyalty] credit for redemption ${redemptionId} failed: ${err.message}`);
    return { credited: false, reason: "error" };
  }
}

// ---------- reversal (refund / void / fraud), admin ----------
async function reverseRedemption({ redemptionId, reason, actor }) {
  const why = String(reason || "").trim();
  if (why.length < 5) throw new LoyaltyError(400, "REASON_REQUIRED", "Give a reason (at least 5 characters)");
  if (!isId(redemptionId)) throw new LoyaltyError(400, "INVALID_ID", "Invalid redemption id");
  const credit = await LoyaltyLedger.findOne({ idempotencyKey: `credit:${redemptionId}` }).lean();
  if (!credit) throw new LoyaltyError(404, "NOT_CREDITED", "This redemption has no loyalty credit");
  if (credit.visitsDelta <= 0) throw new LoyaltyError(409, "NOT_COUNTED", "This redemption did not count as a visit; nothing to reverse");
  const program = await LoyaltyProgram.findById(credit.program).lean();
  try {
    const { result } = await withTransaction(async (session) => {
      const [entry] = await LoyaltyLedger.create([{
        program: credit.program,
        programVersion: program?.version ?? credit.programVersion,
        brand: credit.brand,
        student: credit.student,
        type: "REVERSAL",
        visitsDelta: -credit.visitsDelta,
        redemptionId: credit.redemptionId,
        offer: credit.offer,
        source: "admin",
        reason: why.slice(0, 500),
        reverses: credit._id,
        actor: isId(actor) ? actor : null,
        idempotencyKey: `reverse:${credit._id}`,
        effectiveAt: new Date(),
      }], { session });
      const progress = program ? await rebuildSnapshot(program, credit.brand, credit.student, session) : null;
      return { entry: entry.toObject(), progress };
    });
    await recordSafe("loyalty.reversed", String(credit._id), {
      actor: isId(actor) ? actor : null, subject: { kind: "LoyaltyLedger", id: result.entry._id },
      data: { redemptionId: String(redemptionId), brand: String(credit.brand), student: String(credit.student), reason: why.slice(0, 500) },
    });
    await require("./loyaltyNotify").notifyRow(result.entry, result.progress);
    return result;
  } catch (err) {
    if (err?.code === 11000) throw new LoyaltyError(409, "ALREADY_REVERSED", "This credit was already reversed");
    throw err;
  }
}

// ---------- program writes (routes/loyalty.routes.js) ----------
const RULE_FIELDS = ["tiers", "eligibleOfferIds", "branchIds", "maxDiscountPct", "adminMaxDiscountPct", "maxVisitsPerDay", "resetMonths", "terms", "startsAt", "endsAt", "status"];

async function cleanInput(body, brandId, current = null, isAdmin = false) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  if (has("adminMaxDiscountPct")) {
    if (!isAdmin) throw new LoyaltyError(403, "ADMIN_ONLY", "Only an admin can set the admin maximum discount");
    const v = body.adminMaxDiscountPct;
    out.adminMaxDiscountPct = v == null || v === "" ? null : Number(v);
    if (out.adminMaxDiscountPct != null && !(out.adminMaxDiscountPct >= 0 && out.adminMaxDiscountPct <= 100)) throw new LoyaltyError(400, "INVALID_MAX", "The admin maximum must be 0 to 100");
  }
  if (has("maxDiscountPct")) {
    out.maxDiscountPct = Number(body.maxDiscountPct);
    if (!(out.maxDiscountPct > 0 && out.maxDiscountPct <= 100)) throw new LoyaltyError(400, "INVALID_MAX", "The maximum discount must be more than 0 and at most 100");
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) throw new LoyaltyError(400, "INVALID_STATUS", `Status: ${STATUSES.join(", ")}`);
    if (current?.status === "ended" && body.status !== "ended") throw new LoyaltyError(409, "ENDED", "An ended program can't be restarted; create a new one");
    out.status = body.status;
  }
  for (const k of ["maxVisitsPerDay", "resetMonths"]) {
    if (!has(k)) continue;
    const v = Number(body[k]);
    const max = k === "maxVisitsPerDay" ? 10 : 60;
    if (!Number.isInteger(v) || v < 0 || v > max) throw new LoyaltyError(400, "INVALID_" + k.toUpperCase(), `${k} must be a whole number from 0 to ${max}`);
    out[k] = v;
  }
  if (has("terms")) out.terms = String(body.terms || "").trim().slice(0, 1000);
  for (const k of ["startsAt", "endsAt"]) {
    if (!has(k)) continue;
    const v = body[k] ? new Date(body[k]) : null;
    if (v && Number.isNaN(v.getTime())) throw new LoyaltyError(400, "INVALID_DATE", `${k} is not a date`);
    out[k] = v;
  }
  const startsAt = has("startsAt") ? out.startsAt : current?.startsAt;
  const endsAt = has("endsAt") ? out.endsAt : current?.endsAt;
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) throw new LoyaltyError(400, "INVALID_DATE", "The end must be after the start");
  if (has("eligibleOfferIds")) {
    const ids = [...new Set((body.eligibleOfferIds || []).map(String))];
    if (!ids.every(isId)) throw new LoyaltyError(400, "INVALID_OFFER", "Invalid offer id");
    const own = ids.length ? await Offer.countDocuments({ _id: { $in: ids }, brand: brandId }) : 0;
    if (own !== ids.length) throw new LoyaltyError(403, "NOT_YOUR_OFFER", "Every offer must be your own");
    out.eligibleOfferIds = ids;
  }
  if (has("branchIds")) {
    const ids = [...new Set((body.branchIds || []).map(String))];
    if (!ids.every(isId)) throw new LoyaltyError(400, "INVALID_BRANCH", "Invalid branch id");
    const own = ids.length ? await Branch.countDocuments({ _id: { $in: ids }, brand: brandId }) : 0;
    if (own !== ids.length) throw new LoyaltyError(403, "NOT_YOUR_BRANCH", "Every branch must be your own");
    out.branchIds = ids;
  }
  // tiers checked against the cap that will apply
  const cap = Math.min(
    out.maxDiscountPct ?? current?.maxDiscountPct ?? 100,
    (has("adminMaxDiscountPct") ? out.adminMaxDiscountPct : current?.adminMaxDiscountPct) ?? 100
  );
  if (has("tiers")) out.tiers = validateTiers(body.tiers, isAdmin ? 100 : cap);
  else if (has("maxDiscountPct") && current && !isAdmin) validateTiers(current.tiers, cap);
  return out;
}

async function createProgram(brandId, body = {}, actor) {
  if (await LoyaltyProgram.exists({ brand: brandId })) throw new LoyaltyError(409, "EXISTS", "Your brand already has a loyalty program; edit it instead");
  const input = await cleanInput({ tiers: DEFAULT_TIERS, ...body }, brandId, null, false);
  if (input.maxDiscountPct == null) input.maxDiscountPct = Math.max(...input.tiers.map((t) => t.discountPct));
  validateTiers(input.tiers, input.maxDiscountPct);
  try {
    const p = await LoyaltyProgram.create({ brand: brandId, status: "draft", ...input, version: 1, createdBy: actor, updatedBy: actor });
    await recordSafe("loyalty.program.created", String(p._id), { actor, subject: { kind: "LoyaltyProgram", id: p._id }, data: { brand: String(brandId), status: p.status } });
    return p.toObject();
  } catch (err) {
    if (err?.code === 11000) throw new LoyaltyError(409, "EXISTS", "Your brand already has a loyalty program; edit it instead");
    throw err;
  }
}

// expectedVersion (optional): refuse if someone changed the program meanwhile
async function updateProgram(program, body = {}, actor, isAdmin) {
  const input = await cleanInput(body, program.brand, program, isAdmin);
  if (!Object.keys(input).length) return program;
  if (body.version != null && Number(body.version) !== program.version) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program changed meanwhile; reload it");
  const before = Object.fromEntries(RULE_FIELDS.map((k) => [k, program[k]]));
  const updated = await LoyaltyProgram.findOneAndUpdate(
    { _id: program._id, version: program.version },
    {
      $set: { ...input, updatedBy: actor },
      $inc: { version: 1 },
      $push: { history: { $each: [{ version: program.version, ...before, changedAt: new Date(), changedBy: actor }], $slice: -20 } },
    },
    { new: true }
  ).lean();
  if (!updated) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program changed meanwhile; reload it");
  await recordSafe("loyalty.program.updated", `${program._id}:v${updated.version}`, {
    actor, subject: { kind: "LoyaltyProgram", id: program._id },
    data: { brand: String(program.brand), version: updated.version, fields: Object.keys(input), byAdmin: !!isAdmin },
  });
  return updated;
}

// ---------- brand analytics ----------
async function analytics(brandId, { from = null, to = null } = {}) {
  const program = await LoyaltyProgram.findOne({ brand: brandId }).lean();
  if (!program) return { program: null };
  const entries = await LoyaltyLedger.find({ brand: brandId }).sort({ effectiveAt: 1 }).lean();
  const inRange = (e) => (!from || new Date(e.effectiveAt) >= from) && (!to || new Date(e.effectiveAt) <= to);
  const byStudent = new Map();
  for (const e of entries) {
    const k = String(e.student);
    if (!byStudent.has(k)) byStudent.set(k, []);
    byStudent.get(k).push(e);
  }
  const reversedIds = new Set(entries.filter((e) => e.type === "REVERSAL").map((e) => String(e.reverses)));
  const ranged = entries.filter(inRange);
  const tierCounts = Object.fromEntries(program.tiers.map((t) => [t.name, 0]));
  let members = 0;
  let repeat = 0;
  for (const list of byStudent.values()) {
    const { visits } = tally(list, program);
    if (visits < 1) continue;
    members += 1;
    if (visits >= 2) repeat += 1;
    tierCounts[tierFor(program.tiers, visits).name] += 1;
  }
  const counted = ranged.filter((e) => e.type === "CREDIT" && e.visitsDelta > 0);
  return {
    program: publicProgram(program),
    range: { from, to },
    verifiedVisits: counted.filter((e) => !reversedIds.has(String(e._id))).length,
    creditsNotCounted: ranged.filter((e) => e.type === "CREDIT" && e.visitsDelta === 0).length,
    reversals: ranged.filter((e) => e.type === "REVERSAL").length,
    uniqueStudents: new Set(counted.map((e) => String(e.student))).size,
    members, // students with at least one counted visit (in the reset window)
    repeatCustomers: repeat, // members with 2 or more
    tierCounts, // members by the tier of their latest visit
  };
}

module.exports = {
  DEFAULT_TIERS,
  LoyaltyError,
  enabledFor,
  validateTiers,
  progressOf,
  publicProgram,
  activeProgram,
  standing,
  quoteFor,
  onVerifiedRedemption,
  creditSafe,
  reverseRedemption,
  rebuildSnapshot,
  createProgram,
  updateProgram,
  analytics,
  tally,
};

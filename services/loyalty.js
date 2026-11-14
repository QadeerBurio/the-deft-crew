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
// - Ending is final for that version. restartProgram turns an ended program back into a draft at a new
//   version and records a LoyaltyProgramRestart; credits from the ended period (programVersion <= the ended
//   version) never count again, so a restart never reopens old redemptions.
// - Loyalty applies only where FLAG_LOYALTY_V2 is on for BOTH the brand and the student, and the brand
//   has an active program covering the offer (and branch, if the program names branches).
const mongoose = require("mongoose");
const LoyaltyProgram = require("../models/LoyaltyProgram");
const LoyaltyLedger = require("../models/LoyaltyLedger");
const LoyaltySnapshot = require("../models/LoyaltySnapshot");
const LoyaltyProgramRestart = require("../models/LoyaltyProgramRestart");
const LoyaltyReward = require("../models/LoyaltyReward");
const Offer = require("../models/Offer");
const Branch = require("../models/Branch");
const { isEnabled } = require("../config/featureFlags");
const { recordSafe } = require("./domainEvents");
const { takeSlot, releaseSlot } = require("../models/RedemptionGuard");
const { withTransaction } = require("../utils/transaction");
const { dayKey } = require("../utils/karachiTime");
const User = require("../models/User");

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
    mode: modeOf(p),
    reward: modeOf(p) === "reward" ? rewardView(p) : null,
  };
}

// ---------- reward mode: every N verified visits earn one reward ----------
const modeOf = (p) => (p?.mode === "reward" ? "reward" : "tiers"); // no mode = tiers (programs from before)
const REWARD_KINDS = ["percent", "amount", "item"];
const capPctOf = (p) => Math.min(Number(p.maxDiscountPct ?? 100), p.adminMaxDiscountPct == null ? 100 : Number(p.adminMaxDiscountPct));
function rewardLabel(r, p = null) {
  if (!r) return "";
  if (r.kind === "percent") return `${p ? Math.min(Number(r.value), capPctOf(p)) : r.value}% off`;
  if (r.kind === "amount") return `PKR ${Number(r.value).toLocaleString("en-PK")} off`;
  return String(r.item || "a free item");
}
function rewardView(p) {
  const r = p.reward || {};
  return {
    visitsNeeded: r.visitsNeeded, kind: r.kind, value: r.kind === "percent" ? Math.min(Number(r.value), capPctOf(p)) : r.value ?? null,
    item: r.kind === "item" ? r.item : "", label: rewardLabel(r, p), maxPerStudent: r.maxPerStudent ?? null, maxPerMonth: r.maxPerMonth ?? null,
  };
}
const monthKey = (d) => { const k = new Date(new Date(d).getTime() + 5 * 3600e3); return `${k.getUTCFullYear()}-${k.getUTCMonth() + 1}`; }; // Karachi month

// where a student stands on a reward program: stamps since their last used reward (the count restarts when a
// reward is used; while one is waiting the card stays full), the waiting reward, and any limit reached
async function rewardState(program, brandId, studentId, session = null) {
  const after = Number(program.countAfterVersion) || 0;
  const rewards = (await LoyaltyReward.find({ program: program._id, student: studentId, status: { $ne: "void" } }).sort({ earnedAt: 1 }).session(session).lean())
    .filter((r) => r.programVersion > after); // rewards from an ended period never count or reopen
  const lastUsed = [...rewards].reverse().find((r) => r.status === "used") || null;
  const available = rewards.find((r) => r.status === "available") || null;
  const since = lastUsed ? new Date(lastUsed.usedAt) : null;
  const entries = await LoyaltyLedger.find({ brand: brandId, student: studentId }).session(session).lean();
  const { visits, visitsToday } = tally(entries.filter((e) => !since || new Date(e.effectiveAt) > since), program);
  const needed = Number(program.reward?.visitsNeeded) || 0;
  const now = new Date();
  const thisMonth = rewards.filter((r) => monthKey(r.earnedAt) === monthKey(now)).length;
  const limit = program.reward?.maxPerStudent && rewards.length >= program.reward.maxPerStudent ? "program-limit"
    : program.reward?.maxPerMonth && thisMonth >= program.reward.maxPerMonth ? "monthly-limit" : null;
  return { stamps: visits, visitsToday, needed, available, limit, cycleKey: `${after}:${lastUsed ? lastUsed._id : "start"}`, earned: rewards.length };
}
// what the app and the brand see
function stampsView(program, st, justEarned = false) {
  const shown = Math.min(st.stamps, st.needed);
  return {
    mode: "reward",
    stamps: st.available ? st.needed : shown,
    needed: st.needed,
    visitsToReward: st.available ? 0 : Math.max(0, st.needed - shown),
    reward: rewardView(program),
    available: st.available ? { id: String(st.available._id), label: st.available.label, kind: st.available.kind, value: st.available.value, item: st.available.item, earnedAt: st.available.earnedAt } : null,
    limitReached: st.available ? null : st.limit,
    justEarned: !!justEarned,
  };
}
// after a counted visit: earn the reward when the card is full. One per cycle (unique cycleKey): a retry or a
// simultaneous visit finds it already earned. Never throws into the visit that triggered it.
async function earnRewardIfDue(program, brandId, studentId) {
  if (modeOf(program) !== "reward") return null;
  let earned = null;
  try {
    ({ result: earned } = await withTransaction(async (session) => {
      const st = await rewardState(program, brandId, studentId, session);
      if (st.available || st.limit || !st.needed || st.stamps < st.needed) return null;
      const r = program.reward;
      const [doc] = await LoyaltyReward.create([{
        program: program._id, programVersion: program.version, brand: brandId, student: studentId, cycleKey: st.cycleKey, status: "available",
        kind: r.kind, value: r.kind === "item" ? null : Number(r.value), item: r.kind === "item" ? r.item : "", label: rewardLabel(r, program), visitsNeeded: r.visitsNeeded, earnedAt: new Date(),
      }], { session });
      return doc.toObject();
    }));
  } catch (err) {
    if (err?.code === 11000) return null; // already earned in this cycle
    console.error(`[loyalty] earning a reward failed: ${err.message}`);
    return null;
  }
  if (earned) await recordSafe("loyalty.reward.earned", String(earned._id), { subject: { kind: "LoyaltyReward", id: earned._id }, data: { brand: String(brandId), student: String(studentId), cycleKey: earned.cycleKey, label: earned.label } });
  return earned;
}
// the brand applies a waiting reward at the till: one atomic available -> used change. A retry with the same
// key gets the same answer; any other second use is refused. The admin cap still limits the money off.
async function useReward({ rewardId, brandId, actor, billAmount = null, useKey = null }) {
  if (!isId(rewardId)) throw new LoyaltyError(404, "NOT_FOUND", "Reward not found");
  const r = await LoyaltyReward.findById(rewardId).lean();
  if (!r || !same(r.brand, brandId)) throw new LoyaltyError(404, "NOT_FOUND", "Reward not found");
  const key = useKey ? `use:${String(useKey).slice(0, 100)}` : null;
  if (r.status === "used") {
    if (key && r.useKey === key) return { reward: r, duplicate: true };
    throw new LoyaltyError(409, "ALREADY_USED", "This reward was already used");
  }
  if (r.status !== "available") throw new LoyaltyError(409, "NOT_AVAILABLE", "This reward can't be used");
  if (!enabledFor(brandId, r.student)) throw new LoyaltyError(409, "NOT_ENABLED", "Loyalty isn't on for this student");
  const program = await withPeriod(await LoyaltyProgram.findById(r.program).lean());
  if (!program || program.status !== "active" || r.programVersion <= (Number(program.countAfterVersion) || 0)) throw new LoyaltyError(409, "PROGRAM_NOT_ACTIVE", "This reward's program isn't running");
  let bill = null;
  if (billAmount != null && billAmount !== "") {
    bill = Number(billAmount);
    if (!Number.isFinite(bill) || bill < 0 || bill > 10000000) throw new LoyaltyError(400, "INVALID_BILL", "The bill must be a positive amount");
  }
  const cap = capPctOf(program);
  let saved = null;
  if (r.kind === "percent" && bill != null) saved = Math.round((bill * Math.min(Number(r.value), cap)) / 100);
  if (r.kind === "amount") saved = bill != null ? Math.min(Number(r.value), bill, program.adminMaxDiscountPct != null ? Math.round((bill * program.adminMaxDiscountPct) / 100) : Infinity) : Number(r.value);
  const now = new Date();
  let used;
  try {
    ({ result: used } = await withTransaction(async (session) => {
      const u = await LoyaltyReward.findOneAndUpdate(
        { _id: r._id, status: "available" },
        { $set: { status: "used", usedAt: now, usedBy: isId(actor) ? actor : null, useKey: key || `use:${r._id}`, billAmount: bill, savedAmount: saved } },
        { new: true, session }
      ).lean();
      if (!u) throw new LoyaltyError(409, "ALREADY_USED", "This reward was already used");
      return u;
    }));
  } catch (err) {
    if (err?.code === 11000 || err?.code === "ALREADY_USED") {
      const again = await LoyaltyReward.findById(r._id).lean();
      if (again?.status === "used" && key && again.useKey === key) return { reward: again, duplicate: true };
      throw new LoyaltyError(409, "ALREADY_USED", "This reward was already used");
    }
    throw err;
  }
  await recordSafe("loyalty.reward.used", String(r._id), { actor: isId(actor) ? actor : null, subject: { kind: "LoyaltyReward", id: r._id }, data: { brand: String(brandId), student: String(r.student), savedAmount: saved } });
  return { reward: used, duplicate: false };
}

const running = (p, now = new Date()) => p && p.status === "active" && (!p.startsAt || new Date(p.startsAt) <= now) && (!p.endsAt || now <= new Date(p.endsAt));
// the program with the version its current period counts from (after the latest restart, if any)
async function withPeriod(p) {
  if (!p) return p;
  const last = await LoyaltyProgramRestart.findOne({ program: p._id }).sort({ endedVersion: -1 }).lean();
  return { ...p, countAfterVersion: last ? last.endedVersion : 0 };
}
async function activeProgram(brandId, now = new Date()) {
  if (!isId(brandId)) return null;
  const p = await LoyaltyProgram.findOne({ brand: brandId, status: "active" }).lean();
  return running(p, now) ? withPeriod(p) : null;
}
const offerCovered = (p, offerId) => !(p.eligibleOfferIds || []).length || p.eligibleOfferIds.some((o) => same(o, offerId));
// a branch outside the program doesn't count; an unknown branch does (the counter QR screen, promo codes and store
// webhooks don't know the branch: before, a program with chosen branches silently counted none of those visits)
const branchCovered = (p, branchId) => !(p.branchIds || []).length || !branchId || p.branchIds.some((b) => same(b, branchId));

// ---------- visits, from the ledger ----------
function windowStart(program, now = new Date()) {
  if (!program.resetMonths) return null;
  const d = new Date(now);
  d.setMonth(d.getMonth() - Number(program.resetMonths));
  return d;
}

function tally(entries, program, now = new Date()) {
  const from = windowStart(program, now);
  const after = Number(program.countAfterVersion) || 0; // credits from an ended period never count again
  const reversed = new Set(entries.filter((e) => e.type === "REVERSAL" && e.reverses).map((e) => String(e.reverses)));
  const counted = entries.filter((e) => e.type === "CREDIT" && e.visitsDelta > 0 && !reversed.has(String(e._id)) && (Number(e.programVersion) || 0) > after);
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
  // reward mode: "progress" stays null (app builds from before reward mode then show no card rather than a wrong one)
  if (modeOf(program) === "reward") return { enabled: true, program: publicProgram(program), progress: null, stamps: stampsView(program, await rewardState(program, brandId, studentId)) };
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
  if (modeOf(program) === "reward") {
    // the visit gets the offer's usual discount; the reward is separate (the brand applies a waiting one)
    const st = await rewardState(program, brandId, studentId);
    const countsAsVisit = !program.maxVisitsPerDay || st.visitsToday < program.maxVisitsPerDay;
    return { applies: false, mode: "reward", reason: "reward-mode", programId: String(program._id), programVersion: program.version, countsAsVisit, ...stampsView(program, st) };
  }
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
    let rewardProgress = null;
    if (counts && modeOf(program) === "reward") {
      const earned = await earnRewardIfDue(program, brandId, studentId);
      rewardProgress = stampsView(program, await rewardState(program, brandId, studentId), !!earned);
    }
    if (!counts) {
      // the daily limit: tell the student (in-app + push, once per row) that this visit was already counted today
      await require("./loyaltyNotify").notifyRow(result.entry, { ...(rewardProgress || result.progress || {}), maxVisitsPerDay: program.maxVisitsPerDay }, {});
    }
    if (counts) {
      await recordSafe("loyalty.credited", String(redemptionId), {
        actor: row.actor, subject: { kind: "LoyaltyLedger", id: result.entry._id },
        data: { brand: String(brandId), student: String(studentId), visitNumber: row.visitNumber, tier: tier.name, source: row.source },
      });
      // push + in-app, once per ledger row (services/loyaltyNotify.js); never fails the credit
      await require("./loyaltyNotify").notifyRow(result.entry, rewardProgress || result.progress, { thisVisitPct: rewardProgress ? null : pctOf(program, tier) });
    }
    return { credited: counts, reason: row.reason, visitNumber: row.visitNumber, entry: result.entry, progress: result.progress, ...(rewardProgress ? { stamps: rewardProgress } : {}) };
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
  const program = await withPeriod(await LoyaltyProgram.findById(credit.program).lean());
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
const RULE_FIELDS = ["tiers", "eligibleOfferIds", "branchIds", "maxDiscountPct", "adminMaxDiscountPct", "maxVisitsPerDay", "resetMonths", "terms", "startsAt", "endsAt", "status", "mode", "reward"];

// reward settings: visits needed 2-20, what (% off within the cap, PKR off, or a named item), optional limits
function cleanReward(raw, capPct) {
  const r = raw && typeof raw === "object" ? raw : {};
  const n = Number(r.visitsNeeded);
  if (!Number.isInteger(n) || n < 2 || n > 20) throw new LoyaltyError(400, "INVALID_REWARD", "Visits needed must be a whole number from 2 to 20");
  if (!REWARD_KINDS.includes(r.kind)) throw new LoyaltyError(400, "INVALID_REWARD", "The reward must be % off, PKR off or a free item");
  const out = { visitsNeeded: n, kind: r.kind, value: null, item: "", maxPerStudent: null, maxPerMonth: null };
  if (r.kind === "percent") {
    const v = Number(r.value);
    if (!(v >= 1 && v <= 100)) throw new LoyaltyError(400, "INVALID_REWARD", "The % off must be 1 to 100");
    if (v > capPct) throw new LoyaltyError(400, "OVER_MAX_DISCOUNT", `The reward can't be more than ${capPct}% off`);
    out.value = v;
  } else if (r.kind === "amount") {
    const v = Number(r.value);
    if (!Number.isInteger(v) || v < 1 || v > 100000) throw new LoyaltyError(400, "INVALID_REWARD", "The PKR off must be a whole amount from 1 to 100,000");
    out.value = v;
  } else {
    const item = String(r.item || "").trim();
    if (item.length < 2 || item.length > 80) throw new LoyaltyError(400, "INVALID_REWARD", "Name the free item (2 to 80 characters)");
    out.item = item;
  }
  for (const [k, max] of [["maxPerStudent", 100], ["maxPerMonth", 31]]) {
    if (r[k] == null || r[k] === "") continue;
    const v = Number(r[k]);
    if (!Number.isInteger(v) || v < 1 || v > max) throw new LoyaltyError(400, "INVALID_REWARD", `${k} must be a whole number from 1 to ${max}, or empty`);
    out[k] = v;
  }
  return out;
}

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
    if (current?.status === "ended" && body.status !== "ended") throw new LoyaltyError(409, "ENDED", "This program has ended; restart it to start a new version");
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
  if (has("mode")) {
    if (!["tiers", "reward"].includes(body.mode)) throw new LoyaltyError(400, "INVALID_MODE", "mode must be tiers or reward");
    out.mode = body.mode;
  }
  const mode = out.mode || modeOf(current);
  // the % reward always stays within the brand's maximum and the admin cap
  const rewardCap = Math.min(out.maxDiscountPct ?? current?.maxDiscountPct ?? 100, (has("adminMaxDiscountPct") ? out.adminMaxDiscountPct : current?.adminMaxDiscountPct) ?? 100);
  if (has("reward")) out.reward = cleanReward(body.reward, rewardCap);
  else if (mode === "reward" && (has("mode") || has("maxDiscountPct") || has("adminMaxDiscountPct"))) {
    if (!current?.reward?.visitsNeeded) throw new LoyaltyError(400, "INVALID_REWARD", "Set up the reward: visits needed and what they earn");
    if (current.reward.kind === "percent" && Number(current.reward.value) > rewardCap && !(has("adminMaxDiscountPct") && isAdmin)) throw new LoyaltyError(400, "OVER_MAX_DISCOUNT", `The reward can't be more than ${rewardCap}% off`);
  }
  return out;
}

// opts.session: run inside the caller's transaction (admin writes log in the same one); opts.isAdmin: an admin
// creating it on the brand's behalf (may set adminMaxDiscountPct)
async function createProgram(brandId, body = {}, actor, opts = {}) {
  const session = opts.session || null;
  const existing = await LoyaltyProgram.findOne({ brand: brandId }).select("status").session(session).lean();
  if (existing?.status === "ended") throw new LoyaltyError(409, "EXISTS", "Your brand's loyalty program has ended; restart it to start a new version");
  if (existing) throw new LoyaltyError(409, "EXISTS", "Your brand already has a loyalty program; edit it instead");
  const input = await cleanInput({ tiers: DEFAULT_TIERS, ...body }, brandId, null, !!opts.isAdmin);
  if (input.maxDiscountPct == null) input.maxDiscountPct = Math.max(...input.tiers.map((t) => t.discountPct));
  validateTiers(input.tiers, Math.min(input.maxDiscountPct, input.adminMaxDiscountPct ?? 100));
  try {
    const [p] = await LoyaltyProgram.create([{ brand: brandId, status: "draft", ...input, version: 1, createdBy: actor, updatedBy: actor }], { session });
    await recordSafe("loyalty.program.created", String(p._id), { actor, subject: { kind: "LoyaltyProgram", id: p._id }, data: { brand: String(brandId), status: p.status } });
    return p.toObject();
  } catch (err) {
    if (err?.code === 11000) throw new LoyaltyError(409, "EXISTS", "Your brand already has a loyalty program; edit it instead");
    throw err;
  }
}

// expectedVersion (optional): refuse if someone changed the program meanwhile
async function updateProgram(program, body = {}, actor, isAdmin, opts = {}) {
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
    { new: true, session: opts.session || null }
  ).lean();
  if (!updated) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program changed meanwhile; reload it");
  await recordSafe("loyalty.program.updated", `${program._id}:v${updated.version}`, {
    actor, subject: { kind: "LoyaltyProgram", id: program._id },
    data: { brand: String(program.brand), version: updated.version, fields: Object.keys(input), byAdmin: !!isAdmin },
  });
  return updated;
}

// ---------- restart an ended program ----------
// Ending stays final for the version that ended. A restart makes the same program a draft at a new version
// (same rules; dates cleared), keeps the full history (the program's history + a LoyaltyProgramRestart row),
// and starts a new period: visits from before never count again. One restart per ended version.
async function restartProgram(program, body = {}, actor, isAdmin, opts = {}) {
  if (program.status !== "ended") throw new LoyaltyError(409, "NOT_ENDED", "Only an ended program can be restarted");
  if (body.version != null && Number(body.version) !== program.version) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program changed meanwhile; reload it");
  const before = Object.fromEntries(RULE_FIELDS.map((k) => [k, program[k]]));
  const now = new Date();
  let result;
  try {
    const core = async (session) => {
      const updated = await LoyaltyProgram.findOneAndUpdate(
        { _id: program._id, version: program.version, status: "ended" },
        {
          $set: { status: "draft", startsAt: null, endsAt: null, updatedBy: actor },
          $inc: { version: 1 },
          $push: { history: { $each: [{ version: program.version, ...before, changedAt: now, changedBy: actor, restarted: true }], $slice: -20 } },
        },
        { new: true, session }
      ).lean();
      if (!updated) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program changed meanwhile; reload it");
      await LoyaltyProgramRestart.create([{
        program: program._id, brand: program.brand, endedVersion: program.version, newVersion: updated.version,
        endedAt: program.updatedAt || null, endedRules: before, restartedAt: now, restartedBy: actor || null, byAdmin: !!isAdmin,
      }], { session });
      return updated;
    };
    // inside the caller's transaction when given one (admin writes), otherwise its own
    result = opts.session ? await core(opts.session) : (await withTransaction(core)).result;
  } catch (err) {
    if (err?.code === 11000) throw new LoyaltyError(409, "VERSION_CONFLICT", "The program was already restarted; reload it");
    throw err;
  }
  await recordSafe("loyalty.program.restarted", `${program._id}:v${program.version}`, {
    actor, subject: { kind: "LoyaltyProgram", id: program._id },
    data: { brand: String(program.brand), endedVersion: program.version, newVersion: result.version, byAdmin: !!isAdmin },
  });
  return result;
}

// ---------- brand analytics ----------
async function analytics(brandId, { from = null, to = null } = {}) {
  const program = await withPeriod(await LoyaltyProgram.findOne({ brand: brandId }).lean());
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
    ...(modeOf(program) === "reward" ? { rewards: await rewardCounts(program) } : {}),
  };
}

// reward numbers for the brand (current program period): earned, used, waiting
async function rewardCounts(program) {
  const after = Number(program.countAfterVersion) || 0;
  const list = (await LoyaltyReward.find({ program: program._id, status: { $ne: "void" } }).select("status programVersion").lean()).filter((r) => r.programVersion > after);
  return { earned: list.length, used: list.filter((r) => r.status === "used").length, waiting: list.filter((r) => r.status === "available").length };
}

// ---------- what a redemption did for loyalty (the brand's verify screen and the app say this) ----------
const OUTCOME_MESSAGE = {
  "": "visit counted",
  "daily-limit": "visit already counted today",
  "offer-not-in-program": "this offer isn't part of your loyalty program, so the visit didn't count",
  "branch-not-in-program": "this branch isn't part of your loyalty program, so the visit didn't count",
  "no-program": "no active loyalty program",
  "not-enabled": "loyalty isn't on for this account",
  error: "the visit couldn't be counted right now",
};
/**
 * One shape for every redemption reply: { credited, reason, message, visitNumber, progress, stamps, maxVisitsPerDay }.
 * result: what creditSafe returned (null: not called).
 */
function outcomeOf(result) {
  if (!result) return null;
  const reason = result.credited ? "" : result.duplicate ? (result.entry?.reason || "") : (result.reason || "");
  const credited = !!result.credited || (!!result.duplicate && result.entry?.visitsDelta > 0);
  return {
    credited,
    duplicate: !!result.duplicate,
    reason,
    message: credited ? (result.stamps?.justEarned ? "visit counted · reward ready" : "visit counted") : OUTCOME_MESSAGE[reason] || reason || "the visit didn't count",
    visitNumber: result.visitNumber ?? result.entry?.visitNumber ?? null,
    progress: result.progress || null,
    stamps: result.stamps || null,
  };
}

// ---------- the student's own cards: "my loyalty" (GET /api/loyalty/me/cards) ----------
/** every brand the student has visits at: its card (stamps or tier), rewards earned / ready / used, recent history */
async function myCards(studentId, { historyPerBrand = 10 } = {}) {
  if (!isId(studentId)) return [];
  const rows = await LoyaltyLedger.find({ student: studentId }).sort({ effectiveAt: -1 }).limit(2000).lean();
  const brandIds = [...new Set(rows.map((r) => String(r.brand)))];
  const names = new Map((await User.find({ _id: { $in: brandIds } }).select("brandName name").lean()).map((u) => [String(u._id), u.brandName || u.name || ""]));
  const out = [];
  for (const b of brandIds) {
    if (!enabledFor(b, studentId)) continue;
    const program = await activeProgram(b);
    const mine = rows.filter((r) => String(r.brand) === b);
    const rewards = program ? await LoyaltyReward.find({ brand: b, student: studentId, status: { $ne: "void" } }).sort({ earnedAt: -1 }).lean() : [];
    const card = { brandId: b, brandName: names.get(b) || "", program: program ? publicProgram(program) : null, active: !!program };
    if (program && modeOf(program) === "reward") card.stamps = stampsView(program, await rewardState(program, b, studentId));
    else if (program) card.progress = progressOf(program, tally(mine.slice().reverse(), program).visits);
    card.rewardsEarned = rewards.length;
    card.rewardsUsed = rewards.filter((r) => r.status === "used").length;
    card.rewardReady = rewards.some((r) => r.status === "available");
    const reversed = new Set(mine.filter((r) => r.type === "REVERSAL" && r.reverses).map((r) => String(r.reverses)));
    card.history = [
      ...mine.filter((r) => r.type === "CREDIT").slice(0, historyPerBrand).map((r) => ({
        kind: "visit", at: r.effectiveAt, status: r.visitsDelta > 0 ? (reversed.has(String(r._id)) ? "reversed" : "counted") : "not-counted",
        reason: r.visitsDelta > 0 ? "" : r.reason || "", message: r.visitsDelta > 0 ? "" : OUTCOME_MESSAGE[r.reason] || r.reason || "",
      })),
      ...rewards.slice(0, historyPerBrand).flatMap((r) => [
        { kind: "reward-earned", at: r.earnedAt, label: r.label },
        ...(r.status === "used" ? [{ kind: "reward-used", at: r.usedAt, label: r.label }] : []),
      ]),
    ].sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, historyPerBrand);
    card.lastVisitAt = mine.find((r) => r.type === "CREDIT" && r.visitsDelta > 0)?.effectiveAt || null;
    out.push(card);
  }
  // reward ready first, then the most recent visit
  return out.sort((a, c) => (c.rewardReady - a.rewardReady) || (new Date(c.lastVisitAt || 0) - new Date(a.lastVisitAt || 0)));
}

// ---------- members: who has the brand's loyalty (brand portal "members" tab, admin per brand) ----------
const MEMBER_FILTERS = ["all", "reward-ready", "reward-used"];
/**
 * Every student with a visit (counted or not) at this brand in the current program period:
 *   { members: [{ studentId, label, university, visits, visitsNeeded, rewardsEarned, rewardsUsed, rewardReady, lastVisitAt }],
 *     totals: { members, visitsThisMonth, rewardsEarned, rewardsUsed }, filter, mode }
 * label is "tdc verified user" (as in recent claims): never a name, phone or e-mail.
 */
async function members(brandId, { filter = "all", now = new Date() } = {}) {
  if (!isId(brandId)) throw new LoyaltyError(400, "INVALID_ID", "Invalid brand id");
  const f = MEMBER_FILTERS.includes(filter) ? filter : "all";
  const program = (await LoyaltyProgram.findOne({ brand: brandId, status: { $in: ["active", "paused", "ended"] } }).sort({ updatedAt: -1 }).lean()) || null;
  const after = Number(program?.countAfterVersion) || 0;
  const rows = (await LoyaltyLedger.find({ brand: brandId }).lean()).filter((r) => (Number(r.programVersion) || 0) > after);
  const rewards = program ? (await LoyaltyReward.find({ brand: brandId, status: { $ne: "void" } }).lean()).filter((r) => r.programVersion > after) : [];
  const ids = [...new Set([...rows.map((r) => String(r.student)), ...rewards.map((r) => String(r.student))])];
  const users = new Map((await User.find({ _id: { $in: ids } }).select("university").populate({ path: "university", select: "name" }).lean()).map((u) => [String(u._id), u]));
  const isReward = program && modeOf(program) === "reward";
  const list = [];
  for (const id of ids) {
    const mine = rows.filter((r) => String(r.student) === id);
    const rw = rewards.filter((r) => String(r.student) === id);
    let visits = 0;
    if (program && isReward) visits = (await rewardState(program, brandId, id)).stamps;
    else if (program) visits = tally(mine, program, now).visits;
    const lastVisit = mine.filter((r) => r.type === "CREDIT" && r.visitsDelta > 0).sort((a, b) => new Date(b.effectiveAt) - new Date(a.effectiveAt))[0];
    list.push({
      studentId: id,
      label: "tdc verified user",
      university: users.get(id)?.university?.name || "",
      visits: isReward ? Math.min(visits, Number(program.reward?.visitsNeeded) || visits) : visits,
      visitsNeeded: isReward ? Number(program.reward?.visitsNeeded) || null : null,
      rewardsEarned: rw.length,
      rewardsUsed: rw.filter((r) => r.status === "used").length,
      rewardReady: rw.some((r) => r.status === "available"),
      lastVisitAt: lastVisit?.effectiveAt || null,
    });
  }
  list.sort((a, b) => new Date(b.lastVisitAt || 0) - new Date(a.lastVisitAt || 0));
  const mk = monthKey(now);
  const totals = {
    members: list.length,
    visitsThisMonth: rows.filter((r) => r.type === "CREDIT" && r.visitsDelta > 0 && monthKey(r.effectiveAt) === mk).length
      - rows.filter((r) => r.type === "REVERSAL" && r.visitsDelta < 0 && monthKey(r.effectiveAt) === mk).length,
    rewardsEarned: rewards.length,
    rewardsUsed: rewards.filter((r) => r.status === "used").length,
  };
  const shown = f === "reward-ready" ? list.filter((m) => m.rewardReady) : f === "reward-used" ? list.filter((m) => m.rewardsUsed > 0) : list;
  return { filter: f, mode: program ? modeOf(program) : null, programId: program ? String(program._id) : null, totals, members: shown };
}
/** the same rows as CSV (no phone, no e-mail, no name) */
function membersCsv(view) {
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["student", "university", "visits", "visits needed", "rewards earned", "rewards used", "reward ready", "last visit"];
  const lines = view.members.map((m) => [m.label, m.university, m.visits, m.visitsNeeded ?? "", m.rewardsEarned, m.rewardsUsed, m.rewardReady ? "yes" : "no", m.lastVisitAt ? new Date(m.lastVisitAt).toISOString().slice(0, 10) : ""].map(esc).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}

module.exports = {
  DEFAULT_TIERS,
  outcomeOf,
  OUTCOME_MESSAGE,
  myCards,
  members,
  membersCsv,
  MEMBER_FILTERS,
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
  restartProgram,
  useReward,
  earnRewardIfDue,
  modeOf,
  withPeriod,
  updateProgram,
  analytics,
  tally,
};

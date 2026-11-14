// scripts/loyaltyBackfill.js
// Loyalty visits for redemptions that were never counted (fix/loyalty-visits: a program with chosen branches counted
// none of the counter / promo / webhook visits, and an offer outside the program never reached the counter).
//
// For each ACTIVE loyalty program: every completed redemption (Offer.redemptions[]) at that brand since the program
// started that has no loyalty ledger row is credited through the live counter (services/loyalty.onVerifiedRedemption):
// the same idempotency key credit:<redemptionId>, the same daily limit (counted on the day of the redemption), the
// same offer / branch / flag rules. In order of redemption time. No pushes or in-app notices; rewards that become due
// are earned silently. One admin action ("loyalty.backfill") per brand, with the counts.
//
//   node scripts/loyaltyBackfill.js                               # DRY RUN (default): reads only, prints the plan
//   node scripts/loyaltyBackfill.js --apply --admin <adminUserId> # writes
//   options: --brand <brandId>       only this brand
//            --since YYYY-MM-DD      count redemptions from this date (instead of the program's start)
//            --yes                   (with --apply) don't ask "type APPLY" (for a non-interactive run)
//
// Safe to run again: a redemption with a ledger row is never looked at twice. Needs MONGO_URI (as the server).
// Prints counts per brand, never a student's id, name, phone or e-mail.
require("dotenv").config();
const mongoose = require("mongoose");

const DAY_MS = 864e5;

function parseArgs(argv) {
  const a = { apply: false, adminId: null, brandId: null, since: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--apply") a.apply = true;
    else if (k === "--yes") a.yes = true;
    else if (k === "--admin") a.adminId = argv[++i] || null;
    else if (k === "--brand") a.brandId = argv[++i] || null;
    else if (k === "--since") a.since = argv[++i] || null;
    else if (k === "--dry-run" || k === "--dry") a.apply = false;
    else throw new Error(`unknown option ${k}`);
  }
  if (a.since && Number.isNaN(new Date(`${a.since}T00:00:00+05:00`).getTime())) throw new Error("--since must be YYYY-MM-DD");
  return a;
}

/** when the program started counting: --since, else the latest of its start date, its first publication and its last restart */
async function startOf(program, { since = null, LoyaltyProgramRestart }) {
  if (since) return new Date(`${since}T00:00:00+05:00`); // Karachi midnight
  const firstPublished = (() => {
    // history keeps each earlier version's rules with when it changed: leaving "draft" is the first publication
    const left = (program.history || []).filter((h) => h && h.status === "draft" && h.changedAt).map((h) => new Date(h.changedAt));
    return left.length ? new Date(Math.min(...left)) : null;
  })();
  const restart = await LoyaltyProgramRestart.findOne({ program: program._id }).sort({ restartedAt: -1 }).lean();
  const dates = [program.startsAt, firstPublished || program.createdAt, restart?.restartedAt].filter(Boolean).map((d) => new Date(d));
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

/**
 * The plan for one program: which redemptions would count, which wouldn't and why, how many rewards would become ready.
 * Reads only. Mirrors the counter's rules (services/loyalty.js) so the dry run matches what --apply does.
 */
async function planProgram(program, deps, opts = {}) {
  const { loyalty, Offer, LoyaltyLedger, LoyaltyProgramRestart, dayKey } = deps;
  const brandId = program.brand;
  const since = await startOf(program, { since: opts.since, LoyaltyProgramRestart });
  const offers = await Offer.find({ brand: brandId }).select("_id redemptions").lean();
  const all = [];
  for (const o of offers) for (const r of o.redemptions || []) {
    if (!r?._id || !r.student || !r.redeemedAt) continue;
    if (new Date(r.redeemedAt) < since) continue;
    all.push({ redemptionId: r._id, offerId: o._id, student: r.student, at: new Date(r.redeemedAt) });
  }
  const ids = all.map((r) => r.redemptionId);
  const done = new Set((await LoyaltyLedger.find({ redemptionId: { $in: ids } }).select("redemptionId").lean()).map((e) => String(e.redemptionId)));
  const pending = all.filter((r) => !done.has(String(r.redemptionId))).sort((a, b) => a.at - b.at);

  const out = { brandId: String(brandId), programId: String(program._id), mode: loyalty.modeOf(program), since, found: all.length, alreadyCounted: all.length - pending.length,
    pending, wouldCount: 0, notCounted: { "daily-limit": 0 }, skipped: { "offer-not-in-program": 0, "not-enabled": 0 }, rewardsReady: 0 };
  const after = Number(program.countAfterVersion) || 0;
  const ledgerOf = new Map(); // student → existing ledger rows (counted, this period)
  const counted = new Map(); // `${student}:${day}` → counted visits that day (existing + planned)
  const plannedOf = new Map(); // student → planned counted visit times
  for (const r of pending) {
    const sid = String(r.student);
    if (!loyalty.enabledFor(brandId, r.student)) { out.skipped["not-enabled"]++; continue; }
    if ((program.eligibleOfferIds || []).length && !program.eligibleOfferIds.some((o) => String(o) === String(r.offerId))) { out.skipped["offer-not-in-program"]++; continue; }
    // the redemptions carry no branch: an unknown branch counts (as the counter does)
    if (!ledgerOf.has(sid)) {
      const rows = await LoyaltyLedger.find({ brand: brandId, student: r.student }).lean();
      const reversed = new Set(rows.filter((e) => e.type === "REVERSAL" && e.reverses).map((e) => String(e.reverses)));
      ledgerOf.set(sid, rows.filter((e) => e.type === "CREDIT" && e.visitsDelta > 0 && !reversed.has(String(e._id)) && (Number(e.programVersion) || 0) > after));
      for (const e of ledgerOf.get(sid)) { const k = `${sid}:${dayKey(new Date(e.effectiveAt))}`; counted.set(k, (counted.get(k) || 0) + 1); }
    }
    const k = `${sid}:${dayKey(r.at)}`;
    if (program.maxVisitsPerDay && (counted.get(k) || 0) >= program.maxVisitsPerDay) { out.notCounted["daily-limit"]++; continue; }
    counted.set(k, (counted.get(k) || 0) + 1);
    out.wouldCount++;
    if (!plannedOf.has(sid)) plannedOf.set(sid, []);
    plannedOf.get(sid).push(r.at);
  }
  // reward mode: a student whose card fills with the planned visits gets one reward now (one waiting at a time;
  // visits from before their last used reward don't count toward the next card, as in the app)
  if (out.mode === "reward" && program.reward?.visitsNeeded) {
    for (const [sid, times] of plannedOf) {
      const st = await deps.rewardState(program, brandId, sid);
      if (st.available || st.limit) continue;
      const lastUsedAt = st.lastUsedAt ? new Date(st.lastUsedAt) : null;
      const add = times.filter((t) => !lastUsedAt || t > lastUsedAt).length;
      if (st.stamps + add >= st.needed) out.rewardsReady++;
    }
  }
  return out;
}

/** credit one program's pending redemptions through the live counter (silent); returns what happened */
async function applyProgram(plan, program, deps, { adminId }) {
  const { loyalty, LoyaltyReward } = deps;
  const runStart = new Date();
  const res = { counted: 0, notCounted: {}, skipped: {}, duplicates: 0, errors: 0 };
  for (const r of plan.pending) {
    let out;
    try {
      out = await loyalty.onVerifiedRedemption(r.redemptionId, { source: "backfill", at: r.at, silent: true, actor: adminId });
    } catch (err) {
      res.errors++;
      console.error(`  [backfill] a redemption failed: ${err.name || "Error"}${err.code ? ` ${err.code}` : ""}`);
      continue;
    }
    if (out.duplicate) res.duplicates++;
    else if (out.credited) res.counted++;
    else if (out.entry) res.notCounted[out.reason || "not-counted"] = (res.notCounted[out.reason || "not-counted"] || 0) + 1; // a row was written (daily limit)
    else res.skipped[out.reason || "skipped"] = (res.skipped[out.reason || "skipped"] || 0) + 1; // no row (offer outside the program, ...)
  }
  res.rewardsReady = await LoyaltyReward.countDocuments({ brand: program.brand, status: "available", earnedAt: { $gte: runStart } });
  await deps.adminLog.record({
    adminId, action: "loyalty.backfill", targetType: "LoyaltyProgram", targetId: String(program._id),
    before: { brand: String(program.brand), redemptionsFound: plan.found, alreadyCounted: plan.alreadyCounted, since: plan.since.toISOString() },
    after: { counted: res.counted, notCounted: res.notCounted, skipped: res.skipped, duplicates: res.duplicates, errors: res.errors, rewardsReady: res.rewardsReady },
    reason: "loyalty backfill: redemptions that were never counted (scripts/loyaltyBackfill.js)",
  });
  return res;
}

const fmt = (o) => Object.entries(o).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** the whole run; deps are the real modules unless a test passes fakes. Returns one summary per brand. */
async function run(opts = {}, deps = defaultDeps(), log = console.log) {
  const { apply = false, adminId = null, brandId = null, since = null } = opts;
  if (apply && !mongoose.Types.ObjectId.isValid(String(adminId || ""))) throw new Error("--apply needs --admin <adminUserId> (the admin the log entries are recorded under)");
  if (apply) {
    const admin = await deps.User.findById(adminId).select("role").lean();
    if (!admin || admin.role !== "admin") throw new Error("--admin must be an admin account");
  }
  const q = { status: "active", ...(brandId ? { brand: brandId } : {}) };
  const programs = await deps.LoyaltyProgram.find(q).lean();
  const names = new Map((await deps.User.find({ _id: { $in: programs.map((p) => p.brand) } }).select("brandName name").lean()).map((u) => [String(u._id), u.brandName || u.name || "a brand"]));
  log(`loyalty backfill: ${apply ? "APPLY (writes)" : "DRY RUN (reads only, nothing is written)"}; ${programs.length} active program(s)${brandId ? " (one brand)" : ""}`);
  const summary = [];
  const totals = { found: 0, wouldCount: 0, counted: 0, rewardsReady: 0 };
  for (const program of programs) {
    const plan = await planProgram(program, deps, { since });
    const name = names.get(String(program.brand)) || "a brand";
    log(`\n${name} (${plan.mode}, counting since ${plan.since.toISOString().slice(0, 10)}): ${plan.found} redemption(s), ${plan.alreadyCounted} already counted, ${plan.pending.length} never counted`);
    log(`  would count: ${plan.wouldCount} · not counted (a row with the reason): ${fmt(plan.notCounted)} · skipped (no row): ${fmt(plan.skipped)} · rewards that would become ready: ${plan.rewardsReady}`);
    totals.found += plan.found; totals.wouldCount += plan.wouldCount; totals.rewardsReady += plan.rewardsReady;
    const row = { brandId: plan.brandId, name, plan: { found: plan.found, alreadyCounted: plan.alreadyCounted, pending: plan.pending.length, wouldCount: plan.wouldCount, notCounted: plan.notCounted, skipped: plan.skipped, rewardsReady: plan.rewardsReady } };
    // only when something would be written (a counted visit, or a "not counted" row): a brand whose only pending
    // redemptions are skipped (no row) is left alone, so a second run writes nothing at all, not even a log entry
    const writes = plan.wouldCount + Object.values(plan.notCounted).reduce((n, x) => n + x, 0);
    if (apply && writes > 0) {
      row.applied = await applyProgram(plan, program, deps, { adminId });
      totals.counted += row.applied.counted;
      log(`  APPLIED: counted ${row.applied.counted} · not counted: ${fmt(row.applied.notCounted)} · skipped: ${fmt(row.applied.skipped)} · already there: ${row.applied.duplicates} · errors: ${row.applied.errors} · rewards now ready: ${row.applied.rewardsReady}`);
    }
    summary.push(row);
  }
  log(`\ntotal: ${totals.found} redemption(s) looked at; ${apply ? `counted ${totals.counted}` : `would count ${totals.wouldCount}`}; rewards ${apply ? "now" : "that would become"} ready: ${apply ? summary.reduce((n, r) => n + (r.applied?.rewardsReady || 0), 0) : totals.rewardsReady}`);
  if (!apply) log("dry run: nothing was written. To write: --apply --admin <adminUserId>");
  return summary;
}

function defaultDeps() {
  const loyalty = require("../services/loyalty");
  return {
    loyalty,
    rewardState: loyalty.rewardStateOf,
    LoyaltyProgram: require("../models/LoyaltyProgram"),
    LoyaltyProgramRestart: require("../models/LoyaltyProgramRestart"),
    LoyaltyLedger: require("../models/LoyaltyLedger"),
    LoyaltyReward: require("../models/LoyaltyReward"),
    Offer: require("../models/Offer"),
    User: require("../models/User"),
    adminLog: require("../services/adminActionLog"),
    dayKey: require("../utils/karachiTime").dayKey,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGO_URI) { console.error("Refusing to run: MONGO_URI is not set."); process.exit(1); }
  // which database, without the credentials
  const where = (() => { try { const u = new URL(process.env.MONGO_URI); return `${u.hostname}${u.pathname}`; } catch { return "(unreadable MONGO_URI)"; } })();
  console.log(`database: ${where}`);
  if (args.apply && !args.yes) {
    const answer = await new Promise((resolve) => {
      process.stdout.write(`This WRITES loyalty visits to ${where}. Type APPLY to continue: `);
      process.stdin.once("data", (d) => resolve(String(d).trim()));
    });
    if (answer !== "APPLY") { console.log("stopped: nothing was written."); process.exit(1); }
  }
  // the server's feature flags and student / brand defaults, as at runtime (who has Loyalty)
  await mongoose.connect(process.env.MONGO_URI);
  await require("../services/featureAccess").load();
  try {
    await run(args);
  } finally {
    await mongoose.disconnect();
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => { console.error(`loyalty backfill failed: ${err.message}`); process.exit(1); });
}

module.exports = { run, planProgram, applyProgram, parseArgs, startOf, DAY_MS };

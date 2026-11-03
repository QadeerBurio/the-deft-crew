// services/surplus/sweep.js
// Background job "surplusSweep" (JOB_SURPLUS_SWEEP; on in production, off in staging, like the other jobs:
// config/featureFlags.js). Every minute:
//   1. expired holds give their stock back
//   2. listings whose pickup window has ended close
//   3. orders not collected by the end of the window become NO_SHOW (recorded, never a ban)
//   4. orders verified at handover but never marked paid complete 2 hours after the window
//   5. pickup reminders 30 minutes before the window opens are queued
//   6. the notification outbox is drained
// Each step is a conditional update, so two servers (or two ticks) never do the same thing twice.
const SurplusListing = require("../../models/SurplusListing");
const SurplusOrder = require("../../models/SurplusOrder");
const policy = require("./policy");
const { releaseExpiredHolds } = require("./inventory");
const { move } = require("./orders");
const notifications = require("./notifications");

const INTERVAL_MS = 60 * 1000;

async function closeEndedListings(now) {
  const r = await SurplusListing.updateMany({ status: { $in: ["published", "paused", "sold_out"] }, pickupEnd: { $lte: now } }, { $set: { status: "closed", closedAt: now } });
  return r.modifiedCount || 0;
}

async function markNoShows(now, limit = 200) {
  const due = await SurplusOrder.find({ state: { $in: policy.AWAITING_PICKUP }, pickupEnd: { $lte: now } }).limit(limit).lean();
  let n = 0;
  for (const o of due) {
    try {
      const updated = await move(o, "NO_SHOW", { byRole: "system", note: "not collected by the end of the pickup window", now });
      n += 1;
      await notifications.onOrderEvent(updated, "NO_SHOW", { drainNow: false });
    } catch (err) {
      if (err.code !== "STALE_VERSION") throw err; // moved meanwhile (verified, cancelled): fine
    }
  }
  return n;
}

async function completeVerified(now, limit = 200) {
  const cutoff = new Date(now.getTime() - policy.AUTO_COMPLETE_AFTER_MIN * 60000);
  const due = await SurplusOrder.find({ state: "PICKUP_VERIFIED", pickupEnd: { $lte: cutoff } }).limit(limit).lean();
  let n = 0;
  for (const o of due) {
    try {
      await move(o, "COMPLETED", { byRole: "system", note: "handed over; payment not marked by the brand", now });
      n += 1;
    } catch (err) {
      if (err.code !== "STALE_VERSION") throw err;
    }
  }
  return n;
}

async function queueReminders(now, limit = 500) {
  const soon = new Date(now.getTime() + policy.REMINDER_BEFORE_MIN * 60000);
  const due = await SurplusOrder.find({ state: { $in: policy.AWAITING_PICKUP }, pickupStart: { $gt: now, $lte: soon } }).limit(limit).lean();
  let n = 0;
  for (const o of due) n += await notifications.onOrderEvent(o, "REMINDER", { kind: "reminder", drainNow: false });
  return n;
}

let timer = null;
let running = false;
async function tick(now = new Date()) {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    const out = {};
    const steps = [
      ["holdsReleased", () => releaseExpiredHolds({ now })],
      ["listingsClosed", () => closeEndedListings(now)],
      ["noShows", () => markNoShows(now)],
      ["autoCompleted", () => completeVerified(now)],
      ["remindersQueued", () => queueReminders(now)],
    ];
    for (const [name, fn] of steps) {
      try { out[name] = await fn(); } catch (err) { console.error(`[surplus sweep] ${name} failed: ${err.message}`); }
    }
    const done = await notifications.drain({ limit: 200, now });
    out.delivered = done.filter((r) => r.status === "sent").length;
    return out;
  } finally {
    running = false;
  }
}

function start({ intervalMs = INTERVAL_MS } = {}) {
  if (timer) return timer;
  timer = setInterval(() => { tick().catch((err) => console.error(`[surplus sweep] tick failed: ${err.message}`)); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, closeEndedListings, markNoShows, completeVerified, queueReminders, INTERVAL_MS };

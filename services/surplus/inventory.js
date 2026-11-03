// services/surplus/inventory.js
// Stock for Surprise Box listings. Taking stock is one conditional update
// ({ quantityAvailable: { $gte: qty } } + $inc -qty), so concurrent holds can never take more than there
// is: the last box has one winner. A hold ends exactly once (a conditional update from "active"), and
// only a released or expired hold gives its stock back.
const SurplusListing = require("../../models/SurplusListing");
const SurplusInventoryHold = require("../../models/SurplusInventoryHold");
const SurplusOrder = require("../../models/SurplusOrder");
const SurplusBrandBlock = require("../../models/SurplusBrandBlock");
const { isEnabled } = require("../../config/featureFlags");
const policy = require("./policy");

class SurplusError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}
const PURGE_MS = 7 * 24 * 3600 * 1000;

/** Put stock back (a released / expired hold, a student's in-time cancellation); a sold-out listing reopens */
async function restoreStock(listingId, qty, now = new Date()) {
  await SurplusListing.updateOne({ _id: listingId }, { $inc: { quantityAvailable: qty } });
  await SurplusListing.updateOne({ _id: listingId, status: "sold_out", quantityAvailable: { $gt: 0 }, orderCutoff: { $gt: now } }, { $set: { status: "published" } });
}

/** End an active hold (released | expired | consumed). Returns the hold if this call ended it, else null. */
async function endHold(holdId, state, now = new Date(), extraFilter = {}) {
  const hold = await SurplusInventoryHold.findOneAndUpdate(
    { _id: holdId, state: "active", ...extraFilter },
    { $set: { state, endedAt: now, purgeAt: new Date(now.getTime() + PURGE_MS) } },
    { returnDocument: "after" }
  ).lean();
  if (hold && (state === "released" || state === "expired")) await restoreStock(hold.listing, hold.qty, now);
  return hold;
}

/** Expired holds give their stock back (the sweep, and before every new hold on a listing) */
async function releaseExpiredHolds({ listing = null, now = new Date(), limit = 200 } = {}) {
  const filter = { state: "active", expiresAt: { $lte: now }, ...(listing ? { listing } : {}) };
  const due = await SurplusInventoryHold.find(filter).select("_id").limit(limit).lean();
  let released = 0;
  for (const h of due) if (await endHold(h._id, "expired", now, { expiresAt: { $lte: now } })) released += 1;
  return released;
}

const brandBlocked = async (brandId) => !!(await SurplusBrandBlock.exists({ brand: brandId, active: true }));
const flagOn = (id) => isEnabled("surplusBoxes", { id: String(id) });

/** Can a student order from this listing right now? (published, before cutoff, brand in the pilot and not blocked) */
async function assertOrderable(listing, now = new Date()) {
  if (!listing) throw new SurplusError(404, "NOT_FOUND", "This Surprise Box isn't available");
  if (!flagOn(listing.brand) || (await brandBlocked(listing.brand))) throw new SurplusError(404, "NOT_FOUND", "This Surprise Box isn't available");
  if (listing.status === "sold_out" || listing.quantityAvailable <= 0) throw new SurplusError(409, "SOLD_OUT", "Sold out");
  if (listing.status !== "published") throw new SurplusError(409, "NOT_AVAILABLE", "This Surprise Box isn't available right now");
  if (now >= new Date(listing.orderCutoff) || now >= new Date(listing.pickupEnd)) throw new SurplusError(409, "ORDERS_CLOSED", "Orders for this box have closed");
}

/**
 * Hold stock for a student while they confirm.
 * @returns { hold, created } (created false: the same idempotencyKey again)
 */
async function createHold({ studentId, listingId, qty, idempotencyKey, now = new Date() }) {
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new SurplusError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey (8-80 letters, digits, - or _) is required");
  const again = await SurplusInventoryHold.findOne({ student: studentId, idempotencyKey: key }).lean();
  if (again) return { hold: again, created: false };
  const n = Number(qty);
  if (!Number.isInteger(n) || n < 1 || n > policy.MAX_PER_LISTING) throw new SurplusError(400, "INVALID_QTY", `Choose 1 to ${policy.MAX_PER_LISTING} boxes`);

  await releaseExpiredHolds({ listing: listingId, now });
  const listing = await SurplusListing.findById(listingId).lean();
  await assertOrderable(listing, now);

  // limits: one active order per student per brand (so at most MAX_PER_LISTING boxes from a listing, the
  // most one order can hold); the order's unique activeSlot enforces it again when two holds race
  const activeWithBrand = await SurplusOrder.findOne({ student: studentId, brand: listing.brand, state: { $in: policy.ACTIVE } }).select("_id").lean();
  if (activeWithBrand) throw new SurplusError(409, "ACTIVE_ORDER_WITH_BRAND", "You already have an active Surprise Box order with this brand. Collect or cancel it first.", { orderId: String(activeWithBrand._id) });
  const open = await SurplusInventoryHold.findOne({ student: studentId, listing: listingId, state: "active" }).lean();
  if (open) throw new SurplusError(409, "HOLD_EXISTS", "You're already holding this box. Confirm or release it first.", { holdId: String(open._id) });

  // take the stock: one conditional update, so it can't go below zero
  const taken = await SurplusListing.findOneAndUpdate(
    { _id: listingId, status: "published", quantityAvailable: { $gte: n }, orderCutoff: { $gt: now }, pickupEnd: { $gt: now } },
    { $inc: { quantityAvailable: -n } },
    { returnDocument: "after" }
  ).lean();
  if (!taken) {
    const fresh = await SurplusListing.findById(listingId).select("quantityAvailable status").lean();
    if (fresh && fresh.quantityAvailable > 0 && fresh.quantityAvailable < n) throw new SurplusError(409, "NOT_ENOUGH_LEFT", `Only ${fresh.quantityAvailable} left`, { left: fresh.quantityAvailable });
    throw new SurplusError(409, "SOLD_OUT", "Sold out");
  }
  if (taken.quantityAvailable === 0) await SurplusListing.updateOne({ _id: listingId, status: "published", quantityAvailable: 0 }, { $set: { status: "sold_out" } });

  try {
    const hold = await SurplusInventoryHold.create({ listing: listingId, brand: listing.brand, student: studentId, qty: n, idempotencyKey: key, expiresAt: new Date(now.getTime() + policy.HOLD_MINUTES * 60000) });
    return { hold: hold.toObject(), created: true };
  } catch (err) {
    await restoreStock(listingId, n, now); // the stock goes back whatever went wrong
    if (err?.code !== 11000) throw err;
    const sameKey = await SurplusInventoryHold.findOne({ student: studentId, idempotencyKey: key }).lean();
    if (sameKey) return { hold: sameKey, created: false }; // the same tap twice at once
    const other = await SurplusInventoryHold.findOne({ student: studentId, listing: listingId, state: "active" }).select("_id").lean();
    throw new SurplusError(409, "HOLD_EXISTS", "You're already holding this box. Confirm or release it first.", { holdId: other ? String(other._id) : null });
  }
}

/** The student backs out: the stock goes back now */
async function releaseHold(studentId, holdId, now = new Date()) {
  const hold = await endHold(holdId, "released", now, { student: studentId });
  if (!hold) {
    const h = await SurplusInventoryHold.findOne({ _id: holdId, student: studentId }).lean();
    if (!h) throw new SurplusError(404, "NOT_FOUND", "Hold not found");
    return h; // already ended
  }
  return hold;
}

module.exports = { SurplusError, createHold, releaseHold, endHold, releaseExpiredHolds, restoreStock, assertOrderable, brandBlocked, flagOn };

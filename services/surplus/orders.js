// services/surplus/orders.js
// Surprise Box orders (pay at pickup). Every state change is a conditional update on the current state and
// version, with a history entry, then the notifications are queued (services/surplus/notifications.js).
//   - place: from the student's own active, unexpired hold (consumed atomically), with the disclosures
//     accepted; a repeat with the same idempotencyKey (or the same hold) returns the same order
//   - brand moves: policy.MERCHANT_MOVES; the brand cancels any time before handover (with a reason)
//   - student cancels until 30 minutes before pickup starts; the boxes go back on sale
//   - verify pickup: the order's own brand, at the order's own branch, with the single-use code (or its QR)
//     before the window ends; "paid at pickup" completes it
const mongoose = require("mongoose");
const crypto = require("crypto");
const SurplusListing = require("../../models/SurplusListing");
const SurplusInventoryHold = require("../../models/SurplusInventoryHold");
const SurplusOrder = require("../../models/SurplusOrder");
const Branch = require("../../models/Branch");
const { recordSafe } = require("../domainEvents");
const policy = require("./policy");
const pickupCode = require("./pickupCode");
const { SurplusError, endHold, restoreStock, assertConfigured } = require("./inventory");

const same = (a, b) => String(a) === String(b);
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newRef = () => `SB-${Array.from(crypto.randomBytes(6), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("")}`;
const notify = (order, type, extra) => require("./notifications").onOrderEvent(order, type, extra).catch((e) => console.error(`[surplus] notify ${type} failed: ${e.message}`));

/** Place an order from a hold. Returns { order, created }. */
async function placeOrder({ studentId, holdId, idempotencyKey, acceptedTerms, now = new Date() }) {
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new SurplusError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey (8-80 letters, digits, - or _) is required");
  const again = await SurplusOrder.findOne({ student: studentId, idempotencyKey: key }).lean();
  if (again) return { order: again, created: false };
  assertConfigured("order"); // before the hold is touched: it stays active, its stock stays held until it expires
  if (!isId(holdId)) throw new SurplusError(400, "HOLD_REQUIRED", "Hold the box first");
  if (acceptedTerms !== true) throw new SurplusError(400, "TERMS_REQUIRED", "Please read and accept the food and pickup terms first");

  const hold = await SurplusInventoryHold.findOneAndUpdate(
    { _id: holdId, student: studentId, state: "active", expiresAt: { $gt: now } },
    { $set: { state: "consumed", endedAt: now } },
    { returnDocument: "after" }
  ).lean();
  if (!hold) {
    const fromHold = await SurplusOrder.findOne({ hold: holdId, student: studentId }).lean();
    if (fromHold) return { order: fromHold, created: false }; // the same confirm with another key
    const h = await SurplusInventoryHold.findOne({ _id: holdId, student: studentId }).lean();
    if (!h) throw new SurplusError(404, "NOT_FOUND", "Hold not found");
    if (h.state === "consumed") {
      // a simultaneous confirm took the hold and is creating the order: wait for it (a double tap)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const placed = await SurplusOrder.findOne({ student: studentId, $or: [{ hold: holdId }, { idempotencyKey: key }] }).lean();
        if (placed) return { order: placed, created: false };
        const now2 = await SurplusInventoryHold.findOne({ _id: holdId }).select("state").lean();
        if (now2?.state !== "consumed") break;
      }
      throw new SurplusError(409, "ORDER_IN_PROGRESS", "Your order is being placed. Check My orders in a moment.");
    }
    if (h.state === "active") await endHold(h._id, "expired", now); // time ran out: the stock goes back
    throw new SurplusError(409, "HOLD_EXPIRED", "Your 10 minutes ran out and the box was released. Try again if it's still available.");
  }

  const listing = await SurplusListing.findById(hold.listing).lean();
  const id = new mongoose.Types.ObjectId();
  const nonce = pickupCode.newNonce();
  const code = pickupCode.codeFor(id, nonce);
  const doc = {
    _id: id, listing: listing._id, brand: listing.brand, branch: listing.branch, student: studentId, hold: hold._id,
    idempotencyKey: key, ref: newRef(), qty: hold.qty,
    priceSnapshot: { unitPrice: listing.price, listPrice: listing.listPrice, total: listing.price * hold.qty, currency: listing.currency || "PKR" },
    state: "ORDER_PLACED", activeSlot: `${studentId}:${listing.brand}`,
    pickupStart: listing.pickupStart, pickupEnd: listing.pickupEnd,
    pickupCodeHash: pickupCode.hashOf(code), pickupCodeNonce: nonce,
    disclosures: { ...policy.disclosuresOf(listing), title: listing.title, branchName: listing.location?.branchName || "", address: listing.location?.address || "", city: listing.location?.city || "", acceptedAt: now },
    history: [{ from: "RESERVED", to: "ORDER_PLACED", byRole: "student", by: studentId, at: now }],
  };
  let order;
  try {
    order = (await SurplusOrder.create(doc)).toObject();
  } catch (err) {
    // whatever went wrong, the held boxes go back on sale
    await SurplusInventoryHold.updateOne({ _id: hold._id, state: "consumed", order: null }, { $set: { state: "released" } });
    await restoreStock(listing._id, hold.qty, now);
    if (err?.code === 11000) {
      const sameKey = await SurplusOrder.findOne({ student: studentId, idempotencyKey: key }).lean();
      if (sameKey) return { order: sameKey, created: false };
      throw new SurplusError(409, "ACTIVE_ORDER_WITH_BRAND", "You already have an active Surprise Box order with this brand. Collect or cancel it first.");
    }
    throw err;
  }
  await SurplusInventoryHold.updateOne({ _id: hold._id }, { $set: { order: order._id, purgeAt: new Date(now.getTime() + 7 * 864e5) } });
  recordSafe("surplus.order_placed", String(order._id), { actor: studentId, subject: { kind: "SurplusOrder", id: order._id }, data: { qty: order.qty, total: order.priceSnapshot.total } });
  await notify(order, "ORDER_PLACED");
  return { order, created: true };
}

/**
 * Move an order from one state to another (conditional on state and version).
 * @returns the updated order, or throws STALE_VERSION
 */
async function move(order, to, { byRole, by = null, note = "", version = null, set = {}, now = new Date(), extraFilter = {}, session = null }) {
  // a version from a request must be a whole number (an object or array would reach the query as NaN)
  if (version != null && !Number.isInteger(Number(version))) throw new SurplusError(400, "INVALID_VERSION", "version must be a number");
  const filter = { _id: order._id, state: order.state, version: version == null ? order.version : Number(version), ...extraFilter };
  const terminal = policy.TERMINAL.includes(to);
  const update = {
    $set: { state: to, ...set },
    $inc: { version: 1 },
    $push: { history: { from: order.state, to, byRole, by, note: String(note || "").slice(0, 300), at: now } },
    ...(terminal ? { $unset: { activeSlot: "" } } : {}),
  };
  const updated = await SurplusOrder.findOneAndUpdate(filter, update, { returnDocument: "after", session }).lean();
  if (!updated) throw new SurplusError(409, "STALE_VERSION", "This order changed meanwhile. Reload it and try again.");
  recordSafe(`surplus.${to.toLowerCase()}`, `${order._id}:${updated.version}`, { actor: by, subject: { kind: "SurplusOrder", id: order._id }, data: { from: order.state } });
  return updated;
}

/** A brand moves its own order (confirm, preparing, ready, cancel, complete after handover) */
async function merchantTransition(brandId, orderId, { to, version, reason = "", markPaid = false, now = new Date() }) {
  const order = isId(orderId) ? await SurplusOrder.findOne({ _id: orderId, brand: brandId }).lean() : null;
  if (!order) throw new SurplusError(404, "NOT_FOUND", "Order not found");
  if (!policy.merchantNext(order.state).includes(to)) throw new SurplusError(409, "INVALID_TRANSITION", `Can't move this order from ${order.state} to ${to}`, { allowed: policy.merchantNext(order.state) });
  if (to === "MERCHANT_CANCELLED" && String(reason || "").trim().length < 3) throw new SurplusError(400, "REASON_REQUIRED", "Tell the student why you're cancelling");
  if (to === "COMPLETED" && markPaid !== true) throw new SurplusError(400, "PAYMENT_NOT_MARKED", "Mark that the student paid at pickup to complete the order");
  const set = to === "COMPLETED" ? { paymentState: "paid_at_pickup", paidMarkedAt: now } : to === "MERCHANT_CANCELLED" ? { cancelReason: String(reason).trim().slice(0, 300) } : {};
  const updated = await move(order, to, { byRole: "brand", by: brandId, note: reason, version, set, now });
  if (["CONFIRMED", "READY_FOR_PICKUP", "MERCHANT_CANCELLED", "COMPLETED"].includes(to)) await notify(updated, to);
  return updated;
}

/**
 * An admin cancels an order the brand could still cancel (not yet handed over), with a reason the student sees.
 * Same end state as a brand cancel (MERCHANT_CANCELLED); the history records the admin. opts.session: the
 * caller's transaction (the admin action log row goes in the same one). The student is told after the write.
 */
async function adminCancel(adminId, orderId, { version = null, reason = "", now = new Date(), session = null } = {}) {
  const order = isId(orderId) ? await SurplusOrder.findById(orderId).session(session).lean() : null;
  if (!order) throw new SurplusError(404, "NOT_FOUND", "Order not found");
  if (!policy.merchantNext(order.state).includes("MERCHANT_CANCELLED")) throw new SurplusError(409, "CANNOT_CANCEL", `This order can't be cancelled from ${order.state}`);
  const why = String(reason || "").trim();
  if (why.length < 5) throw new SurplusError(400, "REASON_REQUIRED", "Give a reason (at least 5 characters)");
  return move(order, "MERCHANT_CANCELLED", { byRole: "admin", by: adminId, note: why, version, set: { cancelReason: why.slice(0, 300) }, now, session });
}
const notifyCancelled = (order) => notify(order, "MERCHANT_CANCELLED");

/** The student cancels (until 30 minutes before pickup starts); the boxes go back on sale */
async function cancelByStudent(studentId, orderId, { version = null, now = new Date() } = {}) {
  const order = isId(orderId) ? await SurplusOrder.findOne({ _id: orderId, student: studentId }).lean() : null;
  if (!order) throw new SurplusError(404, "NOT_FOUND", "Order not found");
  if (!policy.AWAITING_PICKUP.includes(order.state)) throw new SurplusError(409, "CANNOT_CANCEL", "This order can't be cancelled any more");
  if (!policy.studentCanCancel(order, now)) {
    throw new SurplusError(409, "CANCEL_WINDOW_PASSED", `Cancelling closes ${policy.STUDENT_CANCEL_BEFORE_MIN} minutes before pickup starts. If you can't collect it, it counts as a no-show.`, { cancelUntil: policy.cancelUntil(order.pickupStart) });
  }
  const updated = await move(order, "CUSTOMER_CANCELLED", { byRole: "student", by: studentId, version, now });
  await restoreStock(order.listing, order.qty, now); // not handed over, still before pickup: back on sale
  await notify(updated, "CUSTOMER_CANCELLED");
  return updated;
}

// wrong codes per brand: 10 in 10 minutes, then wait (codes can't be guessed through the portal)
const attempts = new Map();
function tooManyWrongCodes(brandId, now) {
  const k = String(brandId);
  const list = (attempts.get(k) || []).filter((t) => now - t < 10 * 60000);
  attempts.set(k, list);
  return list.length >= 10;
}
const wrongCode = (brandId, now) => attempts.set(String(brandId), [...(attempts.get(String(brandId)) || []), now.getTime()]);

/**
 * The brand verifies a pickup code (typed, or the QR) at the order's branch.
 * @param input { code | qr, branchId, markPaid }
 */
async function verifyPickup(brandId, { code, qr, branchId, markPaid = false, now = new Date() }) {
  if (tooManyWrongCodes(brandId, now.getTime())) throw new SurplusError(429, "TOO_MANY_ATTEMPTS", "Too many wrong codes. Wait a few minutes and try again.");
  if (!isId(branchId) || !(await Branch.exists({ _id: branchId, brand: brandId }))) throw new SurplusError(403, "WRONG_BRANCH", "Choose one of your branches");
  const parsed = pickupCode.parse(qr || code);
  if (!pickupCode.looksValid(parsed.code)) { wrongCode(brandId, now); throw new SurplusError(400, "INVALID_CODE", "That code isn't valid"); }
  const hash = pickupCode.hashOf(parsed.code);
  let order;
  if (parsed.orderId) order = await SurplusOrder.findOne({ _id: parsed.orderId, brand: brandId, pickupCodeHash: hash }).lean();
  else {
    const found = await SurplusOrder.find({ brand: brandId, pickupCodeHash: hash, state: { $in: [...policy.AWAITING_PICKUP, "PICKUP_VERIFIED", "COMPLETED"] } }).limit(2).lean();
    if (found.length > 1) throw new SurplusError(409, "SCAN_QR", "Scan the student's QR code for this one");
    order = found[0];
  }
  if (!order) { wrongCode(brandId, now); throw new SurplusError(404, "CODE_NOT_FOUND", "No order of yours has this code"); }
  if (!same(order.branch, branchId)) throw new SurplusError(403, "WRONG_BRANCH", "This order is for another branch", { branchName: order.disclosures?.branchName || null });
  if (order.pickupCodeUsedAt) throw new SurplusError(409, "CODE_USED", "This code was already used", { ref: order.ref });
  if (!policy.AWAITING_PICKUP.includes(order.state)) throw new SurplusError(409, "NOT_COLLECTABLE", `This order is ${order.state.toLowerCase().replace(/_/g, " ")}`, { ref: order.ref });
  if (now > new Date(order.pickupEnd)) throw new SurplusError(409, "CODE_EXPIRED", "The pickup window has ended; this code has expired", { ref: order.ref });
  if (now.getTime() < new Date(order.pickupStart).getTime() - policy.EARLY_PICKUP_MIN * 60000) throw new SurplusError(409, "TOO_EARLY", "The pickup window hasn't started yet", { pickupStart: order.pickupStart });

  // single use: only one verification can match pickupCodeUsedAt: null
  let updated = await move(order, "PICKUP_VERIFIED", { byRole: "brand", by: brandId, now, set: { pickupCodeUsedAt: now }, extraFilter: { pickupCodeUsedAt: null } })
    .catch((e) => { if (e.code === "STALE_VERSION") throw new SurplusError(409, "CODE_USED", "This code was already used", { ref: order.ref }); throw e; });
  if (markPaid === true) updated = await move(updated, "COMPLETED", { byRole: "brand", by: brandId, now, set: { paymentState: "paid_at_pickup", paidMarkedAt: now } });
  await notify(updated, updated.state);
  return updated;
}

/** The code and QR for the student's own active order (derived, never stored) */
function pickupFor(order) {
  if (!policy.AWAITING_PICKUP.includes(order.state)) return null;
  if (!pickupCode.configured()) { pickupCode.logNotConfigured("show pickup code"); return { code: null, qr: null, validUntil: order.pickupEnd, unavailable: true }; }
  const code = pickupCode.codeFor(order._id, order.pickupCodeNonce);
  return { code, qr: pickupCode.qrFor(order._id, code), validUntil: order.pickupEnd };
}

module.exports = { placeOrder, merchantTransition, cancelByStudent, verifyPickup, pickupFor, move, newRef, adminCancel, notifyCancelled };

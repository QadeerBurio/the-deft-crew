// services/surplus/cases.js
// Support cases (disputes) and admin actions for Surprise Boxes.
//   - A student opens one case per order, within 24 hours of pickup (handover, or the end of the window
//     for a no-show / a brand cancellation). The order becomes DISPUTED (its previous state is kept).
//   - tdc decides: upheld / not upheld / no action. Nothing is refunded (no money passed through tdc).
//   - Blocking a brand's listings is an admin decision (repeated upheld cases are shown, never automatic):
//     its live listings become "blocked" and it can't publish; lifting it leaves them paused.
const mongoose = require("mongoose");
const SurplusOrder = require("../../models/SurplusOrder");
const SurplusSupportCase = require("../../models/SurplusSupportCase");
const SurplusListing = require("../../models/SurplusListing");
const SurplusBrandBlock = require("../../models/SurplusBrandBlock");
const policy = require("./policy");
const { SurplusError } = require("./inventory");
const { move } = require("./orders");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const DISPUTABLE = ["COMPLETED", "PICKUP_VERIFIED", "NO_SHOW", "MERCHANT_CANCELLED"];
const REASONS = SurplusSupportCase.schema.path("reason").enumValues;

// when the 24 hours start: the handover, else the end of the pickup window (no-show), else the cancellation
function disputeFrom(order) {
  if (order.pickupCodeUsedAt) return new Date(order.pickupCodeUsedAt);
  if (order.state === "MERCHANT_CANCELLED") return new Date([...order.history].reverse().find((h) => h.to === "MERCHANT_CANCELLED")?.at || order.updatedAt);
  return new Date(order.pickupEnd);
}

async function openCase(studentId, { orderId, reason, description = "", evidence = [], now = new Date() }) {
  const order = isId(orderId) ? await SurplusOrder.findOne({ _id: orderId, student: studentId }).lean() : null;
  if (!order) throw new SurplusError(404, "NOT_FOUND", "Order not found");
  if (!REASONS.includes(reason)) throw new SurplusError(400, "INVALID_REASON", "Choose what went wrong", { reasons: REASONS });
  if (await SurplusSupportCase.exists({ order: order._id })) throw new SurplusError(409, "CASE_EXISTS", "You already opened a case for this order");
  if (!DISPUTABLE.includes(order.state)) throw new SurplusError(409, "NOT_DISPUTABLE", "You can open a case after pickup, a no-show or a cancellation by the brand");
  if (now.getTime() > disputeFrom(order).getTime() + policy.DISPUTE_HOURS * 3600e3) throw new SurplusError(409, "DISPUTE_WINDOW_PASSED", `Cases can be opened within ${policy.DISPUTE_HOURS} hours of pickup`);
  const links = (Array.isArray(evidence) ? evidence : []).filter((u) => typeof u === "string" && /^https:\/\/\S{4,500}$/.test(u)).slice(0, 5);
  let created;
  try {
    created = (await SurplusSupportCase.create({
      order: order._id, student: studentId, brand: order.brand, reason, description: String(description || "").trim().slice(0, 1000), evidence: links,
      history: [{ action: "opened", byRole: "student", by: studentId, note: reason, at: now }],
    })).toObject();
  } catch (err) {
    if (err?.code === 11000) throw new SurplusError(409, "CASE_EXISTS", "You already opened a case for this order");
    throw err;
  }
  await move(order, "DISPUTED", { byRole: "student", by: studentId, note: reason, now, set: { stateBeforeDispute: order.state } })
    .catch((e) => console.error(`[surplus] case ${created._id}: order not moved to DISPUTED: ${e.message}`));
  return created;
}

async function decideCase(adminId, caseId, { decision, note = "", now = new Date() }) {
  if (!["upheld", "not_upheld", "no_action"].includes(decision)) throw new SurplusError(400, "INVALID_DECISION", "decision must be upheld, not_upheld or no_action");
  if (String(note || "").trim().length < 3) throw new SurplusError(400, "NOTE_REQUIRED", "Write a short note for the record");
  const updated = await SurplusSupportCase.findOneAndUpdate(
    { _id: caseId, status: "open" },
    { $set: { status: "decided", decision, adminNote: String(note).trim().slice(0, 1000), decidedBy: adminId, decidedAt: now }, $push: { history: { action: `decided:${decision}`, byRole: "admin", by: adminId, note: String(note).trim().slice(0, 300), at: now } } },
    { returnDocument: "after" }
  ).lean();
  if (!updated) {
    if (!isId(caseId) || !(await SurplusSupportCase.exists({ _id: caseId }))) throw new SurplusError(404, "NOT_FOUND", "Case not found");
    throw new SurplusError(409, "ALREADY_DECIDED", "This case is already decided");
  }
  return updated;
}

async function setBrandBlock(adminId, brandId, { blocked, reason = "", now = new Date() }) {
  if (!isId(brandId)) throw new SurplusError(400, "INVALID_BRAND", "Invalid brand");
  if (blocked && String(reason || "").trim().length < 3) throw new SurplusError(400, "REASON_REQUIRED", "Write why the brand's listings are blocked");
  const entry = { active: !!blocked, reason: String(reason || "").trim().slice(0, 500), by: adminId, at: now };
  const row = await SurplusBrandBlock.findOneAndUpdate(
    { brand: brandId },
    { $set: { active: !!blocked, reason: entry.reason, by: adminId }, $push: { history: entry } },
    { upsert: true, returnDocument: "after" }
  ).lean();
  const listings = blocked
    ? await SurplusListing.updateMany({ brand: brandId, status: { $in: ["published", "paused", "sold_out", "draft"] } }, { $set: { status: "blocked" } })
    : await SurplusListing.updateMany({ brand: brandId, status: "blocked" }, { $set: { status: "paused" } });
  return { block: row, listingsChanged: listings.modifiedCount || 0 };
}

module.exports = { openCase, decideCase, setBrandBlock, disputeFrom, DISPUTABLE, REASONS };

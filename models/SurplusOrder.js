// models/SurplusOrder.js
// A Surprise Box order: pickup only, pay at pickup (tdc never takes money). States and who may move them:
// services/surplus/policy.js. Every change is a conditional update on (state, version) plus a history
// entry, so two people can't move the same order at once.
//   - activeSlot ("<student>:<brand>") is set while the order is active and removed when it ends: the
//     partial unique index allows one active order per student per brand.
//   - (student, idempotencyKey) and hold are unique: a repeated "confirm" returns the same order.
//   - The pickup code is never stored: only its hash (services/surplus/pickupCode.js).
//   - disclosures: what the student saw and accepted before confirming.
const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const STATES = ["ORDER_PLACED", "CONFIRMED", "PREPARING", "READY_FOR_PICKUP", "PICKUP_VERIFIED", "COMPLETED", "RESERVATION_EXPIRED", "MERCHANT_CANCELLED", "CUSTOMER_CANCELLED", "NO_SHOW", "DISPUTED", "SOLD_OUT"];

const schema = new mongoose.Schema({
  listing: { type: ObjectId, ref: "SurplusListing", required: true },
  brand: { type: ObjectId, ref: "User", required: true },
  branch: { type: ObjectId, ref: "Branch", required: true },
  student: { type: ObjectId, ref: "User", required: true },
  hold: { type: ObjectId, ref: "SurplusInventoryHold", required: true, unique: true },
  idempotencyKey: { type: String, required: true },
  ref: { type: String, required: true, unique: true }, // short order reference shown to both sides, e.g. "SB-4K7Q2M"
  qty: { type: Number, required: true, min: 1, max: 2 },
  priceSnapshot: {
    unitPrice: { type: Number, required: true },
    listPrice: { type: Number, required: true },
    total: { type: Number, required: true },
    currency: { type: String, default: "PKR" },
  },
  paymentMode: { type: String, enum: ["pay_at_pickup"], default: "pay_at_pickup" },
  paymentState: { type: String, enum: ["unpaid", "paid_at_pickup"], default: "unpaid" },
  paidMarkedAt: { type: Date, default: null },
  state: { type: String, enum: STATES, default: "ORDER_PLACED" },
  stateBeforeDispute: { type: String, default: null },
  activeSlot: { type: String }, // set while active only
  pickupStart: { type: Date, required: true },
  pickupEnd: { type: Date, required: true },
  pickupCodeHash: { type: String, required: true },
  pickupCodeNonce: { type: String, required: true },
  pickupCodeUsedAt: { type: Date, default: null },
  disclosures: { type: Mixed, required: true },
  cancelReason: { type: String, default: "" },
  history: [{
    _id: false,
    from: String,
    to: String,
    byRole: { type: String, enum: ["student", "brand", "admin", "system"] },
    by: { type: ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  }],
  version: { type: Number, default: 1 },
}, { timestamps: true });
schema.index({ student: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ activeSlot: 1 }, { unique: true, partialFilterExpression: { activeSlot: { $type: "string" } } });
schema.index({ brand: 1, state: 1, pickupStart: 1 });
schema.index({ student: 1, createdAt: -1 });
schema.index({ state: 1, pickupEnd: 1 });
schema.index({ listing: 1 });

module.exports = mongoose.models.SurplusOrder || mongoose.model("SurplusOrder", schema);
module.exports.STATES = STATES;

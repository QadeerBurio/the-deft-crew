// models/SurplusSupportCase.js
// A student's dispute about a Surprise Box order, opened within 24 hours of pickup; one per order. tdc
// decides. No money passed through tdc, so nothing is refunded: the case is recorded, and upheld cases
// count toward blocking a brand's listings (an admin decision, never automatic).
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  order: { type: ObjectId, ref: "SurplusOrder", required: true, unique: true },
  student: { type: ObjectId, ref: "User", required: true },
  brand: { type: ObjectId, ref: "User", required: true },
  reason: { type: String, enum: ["not_as_described", "food_safety", "not_handed_over", "wrong_no_show", "merchant_cancelled_late", "charged_wrong_price", "other"], required: true },
  description: { type: String, default: "", maxlength: 1000 },
  evidence: { type: [String], default: [] }, // links to photos the student uploaded elsewhere
  status: { type: String, enum: ["open", "decided"], default: "open" },
  decision: { type: String, enum: ["upheld", "not_upheld", "no_action", null], default: null },
  adminNote: { type: String, default: "", maxlength: 1000 },
  decidedBy: { type: ObjectId, ref: "User", default: null },
  decidedAt: { type: Date, default: null },
  history: [{ _id: false, action: String, byRole: String, by: { type: ObjectId, ref: "User", default: null }, note: String, at: { type: Date, default: Date.now } }],
}, { timestamps: true });
schema.index({ status: 1, createdAt: -1 });
schema.index({ brand: 1, decision: 1 });

module.exports = mongoose.models.SurplusSupportCase || mongoose.model("SurplusSupportCase", schema);

// models/LoyaltyLedger.js
// Append-only record of loyalty visits. CREDIT: one brand-confirmed redemption (visitsDelta 1, or 0 when
// it didn't count, e.g. the daily limit; `reason` says why). REVERSAL: a refund / void / fraud correction
// of one CREDIT (visitsDelta = minus that credit's), with the admin and reason. Rows are never edited or
// deleted; visits = the sum of a student's counted credits minus reversals (services/loyalty.js).
// idempotencyKey "credit:<redemptionId>" / "reverse:<creditId>" is unique: a retried or simultaneous
// write of the same redemption makes one row. Ids, amounts and percentages only, no personal data.
const mongoose = require("mongoose");

const loyaltyLedgerSchema = new mongoose.Schema({
  program: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyProgram", required: true },
  programVersion: { type: Number, required: true },
  brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["CREDIT", "REVERSAL"], required: true },
  visitsDelta: { type: Number, required: true }, // CREDIT 1 or 0, REVERSAL -1 or 0
  redemptionId: { type: mongoose.Schema.Types.ObjectId, required: true }, // Offer.redemptions[]._id
  offer: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", default: null },
  branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
  source: { type: String, default: "" }, // redeem-payment, promo-confirm, promo-verify, woo-webhook, ...
  reason: { type: String, default: "" }, // why a credit didn't count, or why it was reversed
  visitNumber: { type: Number, default: null }, // this credit's visit number (counted credits only)
  tierName: { type: String, default: "" },
  discountPct: { type: Number, default: null }, // the loyalty % applied to this redemption (null: none)
  billAmount: { type: Number, default: null },
  savedAmount: { type: Number, default: null },
  reverses: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyLedger", default: null },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  idempotencyKey: { type: String, required: true, unique: true },
  effectiveAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});
loyaltyLedgerSchema.index({ brand: 1, student: 1, effectiveAt: 1 });
loyaltyLedgerSchema.index({ student: 1, effectiveAt: -1 });
loyaltyLedgerSchema.index({ brand: 1, effectiveAt: -1 });
loyaltyLedgerSchema.index({ redemptionId: 1 });

module.exports = mongoose.models.LoyaltyLedger || mongoose.model("LoyaltyLedger", loyaltyLedgerSchema);

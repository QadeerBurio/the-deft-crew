// models/LoyaltySnapshot.js
// Cache of a student's standing with one brand, rewritten from LoyaltyLedger after every credit or
// reversal (services/loyalty.js rebuildSnapshot). Safe to drop: the ledger is the source of truth.
const mongoose = require("mongoose");

const loyaltySnapshotSchema = new mongoose.Schema({
  brand: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  program: { type: mongoose.Schema.Types.ObjectId, ref: "LoyaltyProgram", required: true },
  visits: { type: Number, default: 0 },
  tierName: { type: String, default: "" }, // the tier of the student's next visit
  discountPct: { type: Number, default: 0 }, // the % that next visit gets
  computedAt: { type: Date, default: Date.now },
});
loyaltySnapshotSchema.index({ brand: 1, student: 1 }, { unique: true });

module.exports = mongoose.models.LoyaltySnapshot || mongoose.model("LoyaltySnapshot", loyaltySnapshotSchema);

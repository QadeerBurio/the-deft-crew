// models/LoyaltyNotice.js
// The notification sent for one loyalty ledger row (services/loyaltyNotify.js): a visit credited, a tier
// unlocked, or a visit reversed by an admin. `ledgerRow` is unique, so each row is notified exactly once,
// however often the credit hook runs. Records what happened to the push (sent, quiet hours, switched off).
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  ledgerRow: { type: ObjectId, ref: "LoyaltyLedger", required: true, unique: true },
  student: { type: ObjectId, ref: "User", required: true },
  brand: { type: ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["visit", "tier_unlocked", "reversed"], required: true },
  title: { type: String, default: "" },
  body: { type: String, default: "" },
  push: { type: String, default: "" }, // sent | quiet_hours | pref_off | no_profile | failed: <reason>
  createdAt: { type: Date, default: Date.now },
});
schema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.models.LoyaltyNotice || mongoose.model("LoyaltyNotice", schema);

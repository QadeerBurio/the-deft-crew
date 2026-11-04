// models/EmployerHiringBillingEvent.js
// The hiring billing ledger. Records only: there is no charging, no payment provider and no invoice.
//   free_hire_consumed             the first verified hire of a company with an active trial (feeWaived, 0)
//   free_hire_restored             that hire was revoked in time (or an admin restored the trial)
//   hire_billable_pending_pricing  any other verified hire: amount null until pricing exists
// idempotencyKey is unique: one decision per verified-hire event, one restore per revoke.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  companyGroupKey: { type: String, default: null }, // null: the employer has no approved company yet
  employerUserId: { type: ObjectId, ref: "User", required: true },
  applicationId: { type: ObjectId, ref: "JobApplication", default: null },
  eventId: { type: ObjectId, ref: "CareerApplicationEvent", default: null },
  trialId: { type: ObjectId, ref: "EmployerHiringTrial", default: null },
  eventType: { type: String, enum: ["free_hire_consumed", "free_hire_restored", "hire_billable_pending_pricing"], required: true },
  feeWaived: { type: Boolean, required: true },
  amount: { type: Number, default: null }, // 0 for the free hire; null while pricing is pending
  currency: { type: String, default: "PKR" },
  policyVersion: { type: String, required: true },
  note: { type: String, default: "" },
  idempotencyKey: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ companyGroupKey: 1, createdAt: -1 });
schema.index({ eventType: 1, createdAt: -1 });
schema.index({ applicationId: 1 });

module.exports = mongoose.models.EmployerHiringBillingEvent || mongoose.model("EmployerHiringBillingEvent", schema);

// models/EmployerHiringTrial.js
// First Hire Free: one fee-waived verified hire per verified company group (unique companyGroupKey), shared
// by every approved employer account of that company. Consumed only when a Sprint 3 hire becomes verified
// (offer accepted + employer confirmed), with a conditional update, so it's consumed once however often the
// hire is reported. A dispute that revokes that hire within 7 days restores it.
//   eligibilityStatus: active (one free hire left) | used | under_review (an admin decides)
//   ("not_activated" is shown when there's no trial yet; it's never stored)
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  companyGroupKey: { type: String, required: true, unique: true },
  activatedBy: { type: ObjectId, ref: "User", required: true },
  eligibilityStatus: { type: String, enum: ["active", "used", "under_review"], default: "active" },
  verifiedAt: { type: Date, required: true }, // when the company was approved
  entitlementCount: { type: Number, default: 1 },
  consumedCount: { type: Number, default: 0 },
  consumedByApplicationId: { type: ObjectId, ref: "JobApplication", default: null },
  consumedByEventId: { type: ObjectId, ref: "CareerApplicationEvent", default: null },
  consumedAt: { type: Date, default: null },
  fraudReviewStatus: { type: String, enum: ["none", "open", "cleared", "revoked"], default: "none" },
  reviewReason: { type: String, default: "" },
  policyVersion: { type: String, required: true },
  version: { type: Number, default: 1 },
  history: [{ _id: false, action: String, status: String, by: { type: ObjectId, ref: "User", default: null }, byRole: String, reason: String, applicationId: { type: ObjectId, default: null }, at: { type: Date, default: Date.now } }],
}, { timestamps: true });
schema.index({ eligibilityStatus: 1, createdAt: -1 });

module.exports = mongoose.models.EmployerHiringTrial || mongoose.model("EmployerHiringTrial", schema);

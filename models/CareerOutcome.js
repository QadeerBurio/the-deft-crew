// models/CareerOutcome.js
// A career outcome a student can show: "Interviewed via TDC" (the employer recorded the interview as
// completed) or "Hired via TDC" (a verified hire: offer accepted + employer confirmed). Private by
// default; the student may make a verified one public and private again. A dispute (the student, within
// 7 days of a hire) or an admin correction revokes it. One outcome per application and type.
const mongoose = require("mongoose");

const careerOutcomeSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    outcomeType: { type: String, enum: ["interviewed", "hired"], required: true },
    // verified: hire confirmed by both; employer-recorded: an interview the employer recorded; revoked
    verificationLevel: { type: String, enum: ["verified", "employer-recorded", "revoked"], required: true },
    employerConfirmedAt: { type: Date, default: null },
    candidateConfirmedAt: { type: Date, default: null }, // the candidate accepted the offer
    disputeWindowEndsAt: { type: Date, default: null },
    disputedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: "", maxlength: 500 },
    visibility: { type: String, enum: ["private", "public"], default: "private" },
    auditEventId: { type: mongoose.Schema.Types.ObjectId, ref: "CareerApplicationEvent", default: null },
  },
  { timestamps: true }
);
careerOutcomeSchema.index({ application: 1, outcomeType: 1 }, { unique: true });
careerOutcomeSchema.index({ candidate: 1, createdAt: -1 });

module.exports = mongoose.models.CareerOutcome || mongoose.model("CareerOutcome", careerOutcomeSchema);

// models/CareerOffer.js
// A job offer on the hiring timeline (services/career/careerOfferService.js). Sent by the employer with a
// deadline; accepted or declined by the candidate; a verified hire needs the acceptance AND the employer's
// confirmation (employerConfirmedAt). No salary or contact details are needed here or in notifications.
// One open offer per application. The timeline (CareerApplicationEvent) is the record.
const mongoose = require("mongoose");

const careerOfferSchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    employer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, default: "", maxlength: 200 }, // the role offered
    terms: { type: String, default: "", maxlength: 2000 }, // what the candidate reads before answering
    offeredAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: ["sent", "accepted", "declined", "withdrawn", "expired"], default: "sent" },
    active: { type: Boolean, default: true }, // sent or accepted
    respondedAt: { type: Date, default: null },
    responseNote: { type: String, default: "", maxlength: 500 },
    employerConfirmedAt: { type: Date, default: null },
    verificationStatus: { type: String, enum: ["none", "verified", "revoked"], default: "none" },
  },
  { timestamps: true }
);
careerOfferSchema.index({ application: 1 }, { unique: true, partialFilterExpression: { active: true } });
careerOfferSchema.index({ employer: 1, offeredAt: -1 });

module.exports = mongoose.models.CareerOffer || mongoose.model("CareerOffer", careerOfferSchema);

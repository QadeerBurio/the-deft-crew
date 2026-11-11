// models/CareerRatingReport.js
// The person rated says a rating is unfair (services/career/ratingService.js). An admin hides it or keeps
// it, with a reason; the decision is recorded here and as a DomainEvent. One report per rating per person.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  rating: { type: ObjectId, ref: "CareerRating", required: true },
  reporter: { type: ObjectId, ref: "User", required: true },
  reporterRole: { type: String, enum: ["employer", "candidate"], required: true },
  reason: { type: String, required: true, maxlength: 500 },
  status: { type: String, enum: ["open", "hidden", "kept"], default: "open" },
  decidedBy: { type: ObjectId, ref: "User", default: null },
  decisionReason: { type: String, default: "" },
  decidedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ rating: 1, reporter: 1 }, { unique: true });
schema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.models.CareerRatingReport || mongoose.model("CareerRatingReport", schema);

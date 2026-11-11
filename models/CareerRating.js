// models/CareerRating.js
// One side's rating of the other after a completed interview or a verified hire (FLAG_CAREER_RATINGS,
// services/career/ratingService.js). One per side per event: `key` = application:kind:ref:raterRole is unique.
//   employer → candidate: communication, punctuality, preparation (1-5)
//   candidate → employer: communication, respect, clarity of the process (1-5)
// Private by default. It reaches the person rated only once released: both sides rated, or the 14-day window
// closed. An employer's average is shown to students only from 5 released ratings, rounded, never with
// comments; a student's ratings are never shown to other employers. An admin can hide one after a report.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  application: { type: ObjectId, ref: "JobApplication", required: true },
  job: { type: ObjectId, ref: "Job", required: true },
  employer: { type: ObjectId, ref: "User", required: true },
  candidate: { type: ObjectId, ref: "User", required: true },
  kind: { type: String, enum: ["interview", "hire"], required: true },
  ref: { type: String, required: true }, // the interview id, or "hire"
  eventAt: { type: Date, required: true },
  windowEndsAt: { type: Date, required: true },
  raterRole: { type: String, enum: ["employer", "candidate"], required: true },
  rater: { type: ObjectId, ref: "User", required: true },
  ratee: { type: ObjectId, ref: "User", required: true },
  answers: { type: mongoose.Schema.Types.Mixed, required: true }, // { question: 1-5 }
  comment: { type: String, default: "", maxlength: 300 },
  releasedAt: { type: Date, default: null }, // set when the other side rates too
  status: { type: String, enum: ["visible", "hidden"], default: "visible" },
  hiddenReason: { type: String, default: "" },
  hiddenBy: { type: ObjectId, ref: "User", default: null },
  hiddenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ ratee: 1, raterRole: 1, status: 1 });
schema.index({ application: 1 });

module.exports = mongoose.models.CareerRating || mongoose.model("CareerRating", schema);

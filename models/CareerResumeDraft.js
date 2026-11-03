// models/CareerResumeDraft.js
// A tailored resume being reviewed (Resume Studio). It never counts toward the 2-resume limit and never
// changes the student's Resume. Each suggestion keeps its validator status; the student accepts,
// rejects or edits it (a "needs confirmation" change only with an explicit "this is true").
// `revision` goes up on every change: a decision sent with an old revision gets 409.
// Unapproved drafts expire after 30 days (expiresAt); approval clears expiresAt.
const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const suggestionSchema = new mongoose.Schema({
  suggestionId: { type: String, required: true },
  kind: { type: String, enum: ["reword", "reorder"], required: true },
  fieldPath: { type: String, required: true },
  original: { type: String, default: "" },
  proposed: { type: String, default: "" },
  reason: { type: String, default: "" },
  sourceFactIds: { type: [String], default: [] },
  status: { type: String, enum: ["ok", "needs_user_confirmation", "blocked"], required: true },
  riskFlags: { type: Mixed, default: [] },
  decision: { type: String, enum: ["pending", "accepted", "rejected", "edited"], default: "pending" },
  editedText: { type: String, default: "" },
  editStatus: { type: String, default: "" },        // validator status of editedText
  editRiskFlags: { type: Mixed, default: [] },
  confirmedTrue: { type: Boolean, default: false }, // the student said this new claim is true
}, { _id: false });

const schema = new mongoose.Schema({
  userId: { type: ObjectId, ref: "User", required: true },
  resumeId: { type: ObjectId, ref: "Resume", required: true },
  tailorJobId: { type: ObjectId, ref: "CareerResumeTailorJob", default: null },
  target: {
    kind: { type: String, enum: ["tdc_job", "pasted"], required: true },
    jobId: { type: ObjectId, ref: "Job", default: null },
    title: { type: String, default: "" },
    excerpt: { type: String, default: "" },
    descriptionHash: { type: String, default: "" },
  },
  promptVersion: { type: String, default: "" },
  sourceRevisionHash: { type: String, required: true },
  provenance: { type: String, default: "" },
  sourceContent: { type: Mixed, required: true },
  facts: { type: Mixed, default: [] },
  suggestions: { type: [suggestionSchema], default: [] },
  match: { type: Mixed, default: {} },
  warnings: { type: [String], default: [] },
  fallback: { type: String, default: null },
  revision: { type: Number, default: 1 },
  status: { type: String, enum: ["open", "approved"], default: "open" },
  approvedVersionId: { type: ObjectId, ref: "CareerResumeApprovedVersion", default: null },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) },
}, { timestamps: true });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CareerResumeDraft || mongoose.model("CareerResumeDraft", schema);

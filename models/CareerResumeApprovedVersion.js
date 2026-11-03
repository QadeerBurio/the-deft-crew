// models/CareerResumeApprovedVersion.js
// An approved tailored resume: an immutable snapshot (contentSnapshot + contentHash) rendered with a
// fixed template version. Never edited after approval; a change means a new draft and a new version.
// One version per draft (unique draftId), so a repeated approve returns the same version.
// Not used in an application: the student can delete it. Used in one: kept, and removed 2 years after
// it was last attached (retainUntil, TTL).
const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  userId: { type: ObjectId, ref: "User", required: true },
  sourceResumeId: { type: ObjectId, ref: "Resume", required: true },
  draftId: { type: ObjectId, ref: "CareerResumeDraft", required: true, unique: true },
  label: { type: String, default: "" },
  target: {
    kind: { type: String, default: "" },
    jobId: { type: ObjectId, ref: "Job", default: null },
    title: { type: String, default: "" },
  },
  contentSnapshot: { type: Mixed, required: true },
  contentHash: { type: String, required: true },
  templateId: { type: String, default: "ats-classic" },
  rendererVersion: { type: String, required: true },
  promptVersion: { type: String, default: "" },
  usedInApplication: { type: Boolean, default: false },
  retainUntil: { type: Date, default: null },
  approvedAt: { type: Date, default: Date.now },
});
schema.index({ userId: 1, approvedAt: -1 });
schema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CareerResumeApprovedVersion || mongoose.model("CareerResumeApprovedVersion", schema);

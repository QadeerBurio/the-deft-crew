// models/CareerResumeTailorJob.js
// One "tailor my resume for this job" request (Resume Studio). Created with 202 and polled; the work
// runs in the background and ends in a CareerResumeDraft. (userId, idempotencyKey) is unique so a
// double tap returns the same job. Ids, hashes and status only. Kept 30 days.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  userId: { type: ObjectId, ref: "User", required: true },
  resumeId: { type: ObjectId, ref: "Resume", required: true },
  idempotencyKey: { type: String, required: true },
  target: {
    kind: { type: String, enum: ["tdc_job", "pasted"], required: true },
    jobId: { type: ObjectId, ref: "Job", default: null },   // tdc_job only
    title: { type: String, default: "" },
    descriptionHash: { type: String, default: "" },
  },
  status: { type: String, enum: ["queued", "running", "succeeded", "failed"], default: "queued" },
  attempts: { type: Number, default: 0 },
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  draftId: { type: ObjectId, ref: "CareerResumeDraft", default: null },
  errorCode: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ userId: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.models.CareerResumeTailorJob || mongoose.model("CareerResumeTailorJob", schema);

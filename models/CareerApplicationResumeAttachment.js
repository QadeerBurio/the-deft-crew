// models/CareerApplicationResumeAttachment.js
// Which approved resume version was sent with a job application. One per application (unique). The
// employer who posted the job sees and downloads exactly this snapshot, nothing else of the student's
// resumes. Kept 2 years (retainUntil, TTL), like the version it points to.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  applicationId: { type: ObjectId, ref: "JobApplication", required: true, unique: true },
  jobId: { type: ObjectId, ref: "Job", required: true },
  userId: { type: ObjectId, ref: "User", required: true },      // the student
  employerId: { type: ObjectId, ref: "User", default: null },   // the job's postedBy
  versionId: { type: ObjectId, ref: "CareerResumeApprovedVersion", required: true },
  contentHash: { type: String, required: true },
  attachedAt: { type: Date, default: Date.now },
  retainUntil: { type: Date, required: true },
});
schema.index({ versionId: 1 });
schema.index({ jobId: 1 });
schema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CareerApplicationResumeAttachment || mongoose.model("CareerApplicationResumeAttachment", schema);

// models/CareerMatchSnapshot.js
// One computed candidate match (services/career/matchingService.js, FLAG_CAREER_MATCHING): which model
// version, which job and resume (by fingerprint), the mandatory criteria, the skill evidence and when. A new
// row only when the job or the candidate's resume changed (a new fingerprint), so every result an employer
// saw can be reproduced. Decision support only: nothing here changes or hides an application.
// The evidence quotes resume text: deleted with the student's account (services/career/retentionService.js).
const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  application: { type: ObjectId, ref: "JobApplication", required: true },
  job: { type: ObjectId, ref: "Job", required: true },
  candidate: { type: ObjectId, ref: "User", required: true },
  employer: { type: ObjectId, ref: "User", default: null },
  // where the resume came from: the approved tailored version sent with the application, else the
  // candidate's most recent resume, else nothing
  source: { kind: { type: String, enum: ["tailored_version", "resume", "none"], required: true }, id: { type: ObjectId, default: null } },
  modelVersion: { type: String, required: true },
  jobFingerprint: { type: String, required: true },
  profileFingerprint: { type: String, required: true },
  relevance: { type: Mixed, required: true }, // { score | null, insufficient, label, formula }
  mandatory: { type: Mixed, default: [] }, // [{ criterion, status: met | not_met | unknown, evidence }]
  mandatorySummary: { type: Mixed, default: {} },
  skills: { type: Mixed, default: {} }, // { matched: [{ skill, evidence: [{ path, text }] }], missing, unknown }
  evidenceSummary: { type: String, default: "" },
  computedAt: { type: Date, default: Date.now },
});
schema.index({ application: 1, modelVersion: 1, jobFingerprint: 1, profileFingerprint: 1 }, { unique: true });
schema.index({ application: 1, computedAt: -1 });
schema.index({ candidate: 1 });

module.exports = mongoose.models.CareerMatchSnapshot || mongoose.model("CareerMatchSnapshot", schema);

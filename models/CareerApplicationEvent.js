// models/CareerApplicationEvent.js
// One step in a job application's history (applied, shortlisted, interview invited, offer accepted, hire
// confirmed, disputed, ...). Append-only: rows are never edited or deleted, except that the retention job and
// account deletion replace personal ids and notes with placeholders (services/career/retentionService.js,
// docs/CAREER_TIMELINE.md). `seq` numbers an application's events 1, 2, 3...; the unique (application, seq)
// index is the optimistic version check: two writers who saw the same version can't both append.
// idempotencyKey is unique: a retried request returns the event it already wrote.
const mongoose = require("mongoose");

const careerApplicationEventSchema = new mongoose.Schema({
  application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true },
  job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
  candidate: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  employer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  seq: { type: Number, required: true }, // the application's version after this event
  type: { type: String, required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // null: the system
  actorRole: { type: String, enum: ["candidate", "employer", "admin", "system"], required: true },
  source: { type: String, default: "" }, // portal, app, legacy, system
  // note: shown to both sides; internalNote: employer / admin only; plus ids, times, interview / offer refs
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  idempotencyKey: { type: String, required: true, unique: true },
  occurredAt: { type: Date, default: Date.now },
});
careerApplicationEventSchema.index({ application: 1, occurredAt: 1 });
careerApplicationEventSchema.index({ application: 1, seq: 1 }, { unique: true });
careerApplicationEventSchema.index({ employer: 1, type: 1, occurredAt: -1 });
careerApplicationEventSchema.index({ type: 1, occurredAt: -1 });

module.exports = mongoose.models.CareerApplicationEvent || mongoose.model("CareerApplicationEvent", careerApplicationEventSchema);

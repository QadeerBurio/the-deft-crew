// models/CareerJobAlert.js
// "A new job that matches your skills" (services/career/jobAlerts.js): one row per student per Karachi day (unique
// key `${student}:${dayKey}`), so a student gets at most one such alert a day, and never two for the same job (checked
// before a row is made). Queued when an internal job goes live, delivered through the pushGateway (caps, quiet hours
// and the "jobsScholarships" opt-out apply), skipped once the job is closed or past its deadline. No contact details.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  job: { type: ObjectId, ref: "Job", required: true },
  student: { type: ObjectId, ref: "User", required: true },
  dayKey: { type: String, required: true }, // Karachi day, YYYY-MM-DD
  key: { type: String, required: true, unique: true }, // `${student}:${dayKey}`
  score: { type: Number, required: true }, // the skill-evidence estimate when queued
  payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // { title, body, data }
  expiresAt: { type: Date, required: true }, // the job's deadline: no alert after it
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: "" },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ job: 1, student: 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.models.CareerJobAlert || mongoose.model("CareerJobAlert", schema);

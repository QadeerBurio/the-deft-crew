// models/CareerInvite.js
// An employer's "invite to apply" for a suggested candidate (services/career/invites.js, FLAG_CAREER_MATCHING).
// One per (job, student). The employer never learns who the student is from an invite: they saw an anonymous label
// and skills; the student decides (interested / declined, or applies through the normal flow, which is the only
// way the employer sees their name). status "applied" and "expired" are worked out when read.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  job: { type: ObjectId, ref: "Job", required: true },
  student: { type: ObjectId, ref: "User", required: true },
  employer: { type: ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["sent", "interested", "declined"], default: "sent" },
  score: { type: Number, default: null }, // the estimate when invited
  dayKey: { type: String, required: true }, // Karachi day it was sent (the daily limit per job)
  expiresAt: { type: Date, default: null }, // the job's deadline
  respondedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ job: 1, student: 1 }, { unique: true });
schema.index({ student: 1, createdAt: -1 });
schema.index({ job: 1, dayKey: 1 });

module.exports = mongoose.models.CareerInvite || mongoose.model("CareerInvite", schema);

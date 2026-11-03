// models/ResumeCreationLock.js
// One row per user while a request that creates a Resume is running (create, upload, duplicate, tailor,
// optimize: routes/resume.routes.js checkResumeLimit). The unique key makes it a per-user lock, so two
// simultaneous requests can't both pass the 2-resume count and end at 3. A crashed request's row expires
// by itself (TTL) and can also be taken over once expiresAt has passed.
const mongoose = require("mongoose");

const resumeCreationLockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // `resume-create:<userId>`
  token: { type: String, required: true }, // the holder; only the holder releases it
  expiresAt: { type: Date, required: true },
});
resumeCreationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.ResumeCreationLock || mongoose.model("ResumeCreationLock", resumeCreationLockSchema);

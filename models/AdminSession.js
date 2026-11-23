// models/AdminSession.js
// Phase A (A-8): one row per admin sign-in, while adminSessionsV1 is on (services/adminSessions.js). A row starts
// "pending" (code e-mailed) or verified (a known device); the token carries its id. lastSeenAt drives the 12-hour idle
// sign-out; revokedAt ends it (idle, suspended, signed out elsewhere, removed). The login history pages read these rows.
// No IP address, no device id in clear: only salted hashes. Kept 180 days.
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    deviceHash: { type: String, default: null, index: true },
    ipHash: { type: String, default: null },
    userAgent: { type: String, default: "", maxlength: 160 },
    verifiedAt: { type: Date, default: null }, // the device's code was entered (or it was known): the 30-day clock
    newDevice: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 40 }, // idle | signed_out | suspended | removed | by_super_admin
    codeAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);
schema.index({ user: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.models.AdminSession || mongoose.model("AdminSession", schema);

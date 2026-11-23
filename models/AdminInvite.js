// models/AdminInvite.js
// Phase A (A-6): an e-mailed invitation for a new team member to set their password. Only a hash of the token is kept;
// valid 72 hours, used once. Kept 30 days after it expires.
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.models.AdminInvite || mongoose.model("AdminInvite", schema);

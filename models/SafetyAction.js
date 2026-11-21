// models/SafetyAction.js
// One-time action links in the safety e-mail (plan P4-1b): "blacklist" or "restore" one account. Only a hash of the
// link's secret is stored. A link works once and expires after 7 days.
const mongoose = require("mongoose");

const safetyActionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    action: { type: String, enum: ["blacklist", "restore"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, maxlength: 200 }, // why the e-mail was sent (no personal data)
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SafetyAction", safetyActionSchema);

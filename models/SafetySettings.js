// models/SafetySettings.js
// Confession safety settings the admin Safety page edits (plan P4-1 / P4-7). One document (key "confessions").
// Missing fields use the defaults in services/safetySettings.js.
const mongoose = require("mongoose");

const helpline = new mongoose.Schema({ name: { type: String, trim: true, maxlength: 80 }, number: { type: String, trim: true, maxlength: 40 }, note: { type: String, trim: true, maxlength: 120 } }, { _id: false });

const safetySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "confessions" },
    // unique reports that hide a confession / comment
    reportThreshold: { type: Number, min: 1, max: 50 },
    // extra banned words (on top of utils/profanity.js)
    bannedWords: { type: [String], default: undefined },
    // shown in the support sheet when a post signals self-harm (owner: call-test before launch)
    helplines: { type: [helpline], default: undefined },
    // owner setting: one evidence report confirmed by the re-check suspends at once (default off)
    suspendOnSingleEvidenceReport: { type: Boolean },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SafetySettings", safetySettingsSchema);

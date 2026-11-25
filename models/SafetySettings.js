// models/SafetySettings.js
// Confession safety settings the admin Safety page edits (plan P4-1 / P4-7). One document (key "confessions").
// Missing fields use the defaults in services/safetySettings.js.
const mongoose = require("mongoose");

const helpline = new mongoose.Schema({ name: { type: String, trim: true, maxlength: 80 }, number: { type: String, trim: true, maxlength: 40 }, note: { type: String, trim: true, maxlength: 120 } }, { _id: false });

const safetySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "confessions" },
    // off: no checks · observe: every check runs on every new post / comment and report, logged only (nothing is
    // blocked, held, hidden, struck or banned) · enforce: the checks act, for accounts with the confessionSafety flag
    mode: { type: String, enum: ["off", "observe", "enforce"] },
    // unique reports that hide a confession / comment
    reportThreshold: { type: Number, min: 1, max: 50 },
    // extra banned words (on top of utils/profanity.js)
    bannedWords: { type: [String], default: undefined },
    // shown in the support sheet when a post signals self-harm (owner: call-test before launch)
    helplines: { type: [helpline], default: undefined },
    // owner setting: one evidence report confirmed by the re-check suspends at once (default off)
    suspendOnSingleEvidenceReport: { type: Boolean },
    // P4-3 / P4-4 (confessionsV2): the post tags (stable id, label the admin can rename, hidden) and the composer's prompt chips
    tags: { type: [{ _id: false, id: String, label: String, hidden: Boolean }], default: undefined },
    prompts: { type: [String], default: undefined },
    // owner (25 Nov 2026): words taken out of confession handles later (no app update)
    blockedHandleWords: { type: [String], default: undefined },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SafetySettings", safetySettingsSchema);

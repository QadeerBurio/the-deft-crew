// models/ResumeSettings.js — resume settings the admin edits (owner, 25 Nov 2026). One document (key "resume").
//   hiddenTemplates: template ids taken out of the app's gallery without an app update (a resume already using one
//   keeps rendering with it)
const mongoose = require("mongoose");

const resumeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "resume" },
    hiddenTemplates: { type: [String], default: undefined },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ResumeSettings", resumeSettingsSchema);

// models/ResumeCoachSession.js
// Resume full fix (flags resumeV2 + resumeCoach): "build it by chatting", saved on the server per resume, so a student
// who closes the app continues where they left off (services/resumeChat.js). messages: what both sides said (the
// student's own words as typed, for their own screen only), cards: what was added to the resume (by entry id). state:
// where the interview is. One session per resume; deleted with nothing else (it never holds anything the resume
// doesn't, apart from the chat lines).
const mongoose = require("mongoose");

const resumeCoachSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  resume: { type: mongoose.Schema.Types.ObjectId, ref: "Resume", required: true },
  // { from: "tdc" | "me", text, card?: { section, entryId, title, lines, field } , at }
  messages: { type: [mongoose.Schema.Types.Mixed], default: [] },
  state: { type: mongoose.Schema.Types.Mixed, default: {} },
  done: { type: Boolean, default: false },
}, { timestamps: true, minimize: false });

resumeCoachSessionSchema.index({ user: 1, resume: 1 }, { unique: true });

module.exports = mongoose.models.ResumeCoachSession || mongoose.model("ResumeCoachSession", resumeCoachSessionSchema);

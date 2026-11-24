// models/ResumeFeedback.js
// P3d (plan P3-7): the AI part of a resume's feedback, cached per resume content (contentHash). A change to the text
// makes a new hash and one new AI pass; a template or colour change doesn't. Kept 30 days.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  user: { type: ObjectId, ref: "User", required: true },
  resume: { type: ObjectId, ref: "Resume", required: true },
  contentHash: { type: String, required: true },
  ai: { type: mongoose.Schema.Types.Mixed, default: null }, // { strong: [], weak: [], improvements: [{ text, stepKey }] }
  createdAt: { type: Date, default: Date.now },
});
schema.index({ resume: 1, contentHash: 1 }, { unique: true });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.models.ResumeFeedback || mongoose.model("ResumeFeedback", schema);

// models/CareerResumeSourceConfirmation.js
// The student checked the details read from their uploaded resume and confirmed them, for this exact
// revision of the resume (revisionHash). Until then a parsed upload is unverified and can't back a
// tailoring change; any later edit changes the hash and needs a new confirmation.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  userId: { type: ObjectId, ref: "User", required: true },
  resumeId: { type: ObjectId, ref: "Resume", required: true },
  revisionHash: { type: String, required: true },
  confirmedAt: { type: Date, default: Date.now },
});
schema.index({ userId: 1, resumeId: 1, revisionHash: 1 }, { unique: true });

module.exports = mongoose.models.CareerResumeSourceConfirmation || mongoose.model("CareerResumeSourceConfirmation", schema);

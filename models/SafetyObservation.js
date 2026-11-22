// models/SafetyObservation.js
// Observe mode (confession safety, P4-1 follow-up): what the checks decided on a real post, comment or report, and what
// enforcement WOULD have done. Nothing was blocked or hidden. Kept 90 days. The author's id is stored for the admin's
// counts only (select: false) and never sent; the admin page shows the anonymous reference.
const mongoose = require("mongoose");

const reason = new mongoose.Schema({ code: String, message: String, span: String }, { _id: false });

const safetyObservationSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["confession", "comment", "report"], required: true },
    confessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Confession" },
    commentId: { type: mongoose.Schema.Types.ObjectId },
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: "Report" },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", select: false },
    // the check's verdict: ok | edit | hold | selfharm (for reports: confirmed | not_confirmed | unavailable)
    verdict: { type: String, required: true },
    // what enforcement would have done: none | block | hold | support | hide | remove
    wouldHave: { type: String, required: true },
    reasons: { type: [reason], default: [] },
    severe: { type: Boolean, default: false },
    aiOk: { type: Boolean, default: true },
    text: { type: String, maxlength: 600 },
    image: { type: String, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
safetyObservationSchema.index({ createdAt: -1 });
safetyObservationSchema.index({ wouldHave: 1, createdAt: -1 });
safetyObservationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model("SafetyObservation", safetyObservationSchema);

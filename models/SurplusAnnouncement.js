// models/SurplusAnnouncement.js
// "A new Surprise Box near you": one row per student per Karachi day (unique key `${student}:${dayKey}`), so a
// student gets at most one such push a day whatever the number of boxes published (services/surplus/announcements.js).
// The row is queued when a box is first published, delivered through the pushGateway (caps, quiet hours and the
// "deals" opt-out apply), and skipped once the box can't be ordered any more. No contact details in the payload.
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  listing: { type: ObjectId, ref: "SurplusListing", required: true },
  brand: { type: ObjectId, ref: "User", required: true },
  student: { type: ObjectId, ref: "User", required: true },
  dayKey: { type: String, required: true }, // Karachi day, YYYY-MM-DD
  key: { type: String, required: true, unique: true }, // `${student}:${dayKey}`
  payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // { title, body, data }
  expiresAt: { type: Date, required: true }, // the box's order cutoff: no push after it
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: "" },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ listing: 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.models.SurplusAnnouncement || mongoose.model("SurplusAnnouncement", schema);

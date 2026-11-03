// models/SurplusNotificationOutbox.js
// Surprise Box notifications, the CareerNotificationOutbox pattern: one row per (order event, recipient,
// channel), unique `key`, so a re-run queues nothing new; delivery retries only touch this row.
// Reminders (30 minutes before pickup) are rows with kind "reminder" and expire at the pickup end.
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  kind: { type: String, enum: ["event", "reminder"], default: "event" },
  eventType: { type: String, required: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "SurplusOrder", required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  channel: { type: String, enum: ["push", "inapp"], required: true },
  key: { type: String, required: true, unique: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // { title, body, data } - no contact details
  expiresAt: { type: Date, default: null },
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: "" },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

module.exports = mongoose.models.SurplusNotificationOutbox || mongoose.model("SurplusNotificationOutbox", schema);

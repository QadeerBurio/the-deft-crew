// models/CareerNotificationOutbox.js
// One notification to send for one timeline event: event + recipient + channel (push, in-app, email) is
// unique, so an event is queued once per person and channel however often it is processed. Delivery
// retries only touch this row; the business event (CareerApplicationEvent) is never written again.
const mongoose = require("mongoose");

const careerNotificationOutboxSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: "CareerApplicationEvent", required: true },
  eventType: { type: String, required: true },
  application: { type: mongoose.Schema.Types.ObjectId, ref: "JobApplication", required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  channel: { type: String, enum: ["push", "inapp", "email"], required: true },
  key: { type: String, required: true, unique: true }, // `${event}:${recipient}:${channel}`
  payload: { type: mongoose.Schema.Types.Mixed, default: {} }, // { title, body, data } — no contact details
  status: { type: String, enum: ["pending", "sending", "sent", "failed", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: "" },
  nextAttemptAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});
careerNotificationOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
careerNotificationOutboxSchema.index({ application: 1, createdAt: -1 });

module.exports = mongoose.models.CareerNotificationOutbox || mongoose.model("CareerNotificationOutbox", careerNotificationOutboxSchema);

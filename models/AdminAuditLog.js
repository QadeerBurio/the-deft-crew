// models/AdminAuditLog.js
// One entry per account deletion (by an admin, or the user's own "delete my account").
// Ids, role, time and counts only: no names, e-mails, phone numbers or other personal data.
const mongoose = require("mongoose");

const adminAuditLogSchema = new mongoose.Schema({
  action: { type: String, enum: ["delete-account", "self-delete"], required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, default: null }, // null for a self-delete
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, required: true },
  status: { type: String, enum: ["running", "done", "failed"], default: "running", index: true },
  // the RedemptionArchive deletionId, reused if the same deletion is run again
  deletionId: { type: String, required: true },
  transaction: { type: Boolean, default: false },
  // per collection: { deleted, anonymised, updated, ... }
  counts: { type: mongoose.Schema.Types.Mixed, default: {} },
  // steps after the database commit: images and files, AI chat history, caches
  external: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: String, default: "" },
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
});

adminAuditLogSchema.index({ startedAt: -1 });

module.exports = mongoose.models.AdminAuditLog || mongoose.model("AdminAuditLog", adminAuditLogSchema);

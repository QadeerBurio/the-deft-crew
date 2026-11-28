const mongoose = require("mongoose");

const REASONS = ["child_exploitation", "child_grooming", "harassment", "violence", "sexual_content", "other"];
const TARGETS = ["General", "User", "Post", "Comment", "Confession", "ConfessionComment", "Conversation", "Message"];
const STATUSES = ["pending", "under_review", "resolved"];
const id = mongoose.Schema.Types.ObjectId;
const schema = new mongoose.Schema({
  reporter: { type: id, required: true },
  reason: { type: String, enum: REASONS, required: true },
  description: { type: String, maxlength: 1000, required: true },
  reference: { type: String, maxlength: 200 },
  targetType: { type: String, enum: TARGETS, required: true },
  targetId: id,
  parentId: id,
  subject: id,
  priority: { type: Number, enum: [0, 1, 2], required: true },
  status: { type: String, enum: STATUSES, default: "pending" },
  assignedModerator: id,
  resolutionNotes: String,
  resolvedAt: Date,
  escalation: { type: String, enum: ["none", "planned", "reported"], default: "none" },
  history: [{ _id: false, actor: id, at: Date, action: String, status: String, escalation: String, note: String }],
}, { timestamps: true });

schema.index({ reporter: 1, createdAt: -1 });
schema.index({ status: 1, priority: -1, createdAt: -1 });

module.exports = { SafetyReport: mongoose.model("SafetyReport", schema), REASONS, TARGETS, STATUSES };

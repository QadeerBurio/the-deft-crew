// models/AdminAccessChange.js
// Phase A (A-6 safety rules): making or unmaking a super admin while more than one exists waits for another super
// admin's confirmation. One row per request: pending → confirmed (applied) or cancelled.
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    target: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    change: { type: { level: { type: String, enum: ["super", "member"] } }, required: true },
    reason: { type: String, default: "", maxlength: 300 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "confirmed", "cancelled"], default: "pending", index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AdminAccessChange || mongoose.model("AdminAccessChange", schema);

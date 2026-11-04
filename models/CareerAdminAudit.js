// models/CareerAdminAudit.js
// Every admin decision on company verifications and First Hire Free trials: who, what, why, when, and the
// state before and after. Append-only (AdminAuditLog, used by account deletion, is unchanged).
const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const schema = new mongoose.Schema({
  admin: { type: ObjectId, ref: "User", required: true },
  action: { type: String, required: true }, // e.g. "verification.approve", "trial.restore"
  targetType: { type: String, enum: ["EmployerCompanyVerification", "EmployerHiringTrial"], required: true },
  targetId: { type: ObjectId, required: true },
  reason: { type: String, required: true, maxlength: 500 },
  before: { type: Mixed, default: null },
  after: { type: Mixed, default: null },
  at: { type: Date, default: Date.now },
});
schema.index({ targetType: 1, targetId: 1, at: -1 });
schema.index({ admin: 1, at: -1 });

module.exports = mongoose.models.CareerAdminAudit || mongoose.model("CareerAdminAudit", schema);

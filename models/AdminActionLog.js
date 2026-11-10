// models/AdminActionLog.js
// One row per admin write, across features (services/adminActionLog.js). Append-only: the server writes rows and
// the admin page reads them; nothing updates or deletes a row (the hooks below refuse it). The before / after
// summaries hold the changed fields only, scrubbed of personal data and secrets before they're saved.
// Separate from AdminAuditLog (account deletion) and CareerAdminAudit (First Hire Free), which are unchanged.
const mongoose = require("mongoose");

const adminActionLogSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true, trim: true, maxlength: 80 }, // e.g. "loyalty.program.update"
    targetType: { type: String, required: true, trim: true, maxlength: 60 }, // e.g. "LoyaltyProgram"
    targetId: { type: String, required: true, trim: true, maxlength: 64 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
    requestId: { type: String, default: "", maxlength: 80 },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false, minimize: false }
);
adminActionLogSchema.index({ at: -1 });
adminActionLogSchema.index({ admin: 1, at: -1 });
adminActionLogSchema.index({ action: 1, at: -1 });
adminActionLogSchema.index({ targetType: 1, targetId: 1, at: -1 });

// append-only: no updates, no deletes through the model
// (hooks throw rather than call next: works with every Mongoose middleware style)
const refuse = function () { throw new Error("AdminActionLog is append-only"); };
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace"]) {
  adminActionLogSchema.pre(op, { document: false, query: true }, refuse);
}
adminActionLogSchema.pre(["updateOne", "deleteOne"], { document: true, query: false }, refuse);
adminActionLogSchema.pre("save", function () {
  if (!this.isNew) throw new Error("AdminActionLog is append-only");
});

module.exports = mongoose.models.AdminActionLog || mongoose.model("AdminActionLog", adminActionLogSchema);

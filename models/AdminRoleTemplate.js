// models/AdminRoleTemplate.js
// Phase A (A-3, A-6): role templates a super admin created, copied or changed. A row whose key is a built-in
// template's id (config/adminPermissions.js TEMPLATES) replaces that template; other keys are new templates.
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 60 },
    label: { type: String, required: true, maxlength: 60 },
    permissions: { type: [String], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AdminRoleTemplate || mongoose.model("AdminRoleTemplate", schema);

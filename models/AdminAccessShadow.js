// models/AdminAccessShadow.js
// Phase A shadow mode (adminRbacEnforce off): each "would deny" (a member admin used a route without its permission;
// allowed anyway) for review before enforcement. At most one row per admin + permission + route per hour; kept 30 days.
const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    permission: { type: String, required: true, maxlength: 60 },
    where: { type: String, default: "", maxlength: 120 }, // "GET /api/admin/users/all"
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false }
);
schema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.models.AdminAccessShadow || mongoose.model("AdminAccessShadow", schema);

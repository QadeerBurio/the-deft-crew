// models/FeatureDefault.js
// A feature's default for every account of a role ("student" only for now), set from the admin portal
// (routes/adminFeatures.routes.js, services/featureAccess.js). One row per flag and role: a change overwrites it, and
// the full history (who, before / after, reason) is in AdminActionLog (feature.default). How it's used is in
// config/featureFlags.js: after the kill switch and the account's own row, before the Railway rules.
const mongoose = require("mongoose");
const { STUDENT_DEFAULTABLE } = require("../config/featureFlags");

const featureDefaultSchema = new mongoose.Schema(
  {
    flag: { type: String, required: true, enum: STUDENT_DEFAULTABLE },
    role: { type: String, required: true, enum: ["student"] },
    enabled: { type: Boolean, required: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // the admin
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    setAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);
featureDefaultSchema.index({ flag: 1, role: 1 }, { unique: true });

module.exports = mongoose.models.FeatureDefault || mongoose.model("FeatureDefault", featureDefaultSchema);
module.exports.DEFAULTABLE = { student: STUDENT_DEFAULTABLE };

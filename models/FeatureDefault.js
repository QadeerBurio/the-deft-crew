// models/FeatureDefault.js
// A feature's default for every account of a role (student, brand, employee), set from the admin portal
// (routes/adminFeatures.routes.js, services/featureAccess.js). One row per flag and role: a change overwrites it, and
// the full history (who, before / after, reason) is in AdminActionLog (feature.default). How it's used is in
// config/featureFlags.js: after the kill switch and the account's own row, before the Railway rules. No row = ON for
// the features ROLE_DEFAULTS lists for that role; a row with enabled: false turns the role's default off.
const mongoose = require("mongoose");
const { STUDENT_DEFAULTABLE, DEFAULTABLE_FLAGS, DEFAULT_ROLES, ROLE_DEFAULTS, defaultable } = require("../config/featureFlags");

const featureDefaultSchema = new mongoose.Schema(
  {
    flag: { type: String, required: true, enum: DEFAULTABLE_FLAGS },
    role: { type: String, required: true, enum: DEFAULT_ROLES },
    enabled: { type: Boolean, required: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // the admin
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    setAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);
featureDefaultSchema.index({ flag: 1, role: 1 }, { unique: true });

module.exports = mongoose.models.FeatureDefault || mongoose.model("FeatureDefault", featureDefaultSchema);
module.exports.DEFAULTABLE = Object.fromEntries(DEFAULT_ROLES.map((r) => [r, ROLE_DEFAULTS[r].filter((f) => defaultable(f, r))]));
module.exports.STUDENT_DEFAULTABLE = STUDENT_DEFAULTABLE;

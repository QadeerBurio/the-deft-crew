// models/FeatureAccess.js
// Admin access to a feature flag for one account (brand, employer or student), set from the admin portal
// (routes/adminFeatures.routes.js, services/featureAccess.js). One row per account and flag: a change overwrites
// the row, and the full history (who, before / after, reason) is in AdminActionLog (feature.grant / feature.revoke).
// A flag is on for an account with a row where enabled is true, OR when the account matches the Railway rules,
// unless the Railway value is only "off" (the kill switch) (config/featureFlags.js).
const mongoose = require("mongoose");
const { FLAGS } = require("../config/featureFlags");

const GRANTABLE = Object.keys(FLAGS).filter((k) => FLAGS[k].grant);

const featureAccessSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    flag: { type: String, required: true, enum: GRANTABLE },
    enabled: { type: Boolean, required: true },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // the admin
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 500 },
    setAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);
featureAccessSchema.index({ account: 1, flag: 1 }, { unique: true });
featureAccessSchema.index({ flag: 1, enabled: 1 });

module.exports = mongoose.models.FeatureAccess || mongoose.model("FeatureAccess", featureAccessSchema);
module.exports.GRANTABLE = GRANTABLE;

// models/UserNotificationSetting.js
// Notification switches that aren't in EngagementProfile.notifPrefs (that schema stays as it is). One row per
// user and switch, written only when the user turns it off or back on; no row = the default (on).
//   loyalty  pushes about loyalty visits, tiers and reversals (FLAG_LOYALTY_V2, services/loyaltyNotify.js)
const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  key: { type: String, enum: ["loyalty"], required: true },
  enabled: { type: Boolean, required: true },
  updatedAt: { type: Date, default: Date.now },
});
schema.index({ user: 1, key: 1 }, { unique: true });

module.exports = mongoose.models.UserNotificationSetting || mongoose.model("UserNotificationSetting", schema);

// models/SocialPushDaily.js
// How many social pushes (posts, confessions, listings together) a student got on one Karachi
// day, for the daily ceiling (SOCIAL_PUSH_DAILY_MAX, default 10). Removed after 3 days.
const mongoose = require("mongoose");

const socialPushDailySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  day: { type: String, required: true }, // dayKey(): YYYY-MM-DD in Karachi
  count: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

socialPushDailySchema.index({ user: 1, day: 1 }, { unique: true });
socialPushDailySchema.index({ day: 1, count: 1 });
socialPushDailySchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.models.SocialPushDaily || mongoose.model("SocialPushDaily", socialPushDailySchema);

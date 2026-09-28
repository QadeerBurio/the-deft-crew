// models/UserBadge.js
const mongoose = require('mongoose');

const badgeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    badgeId: { type: String, required: true },
    earnedAt: { type: Date, default: Date.now },
    shownAt: { type: Date, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

badgeSchema.index({ user: 1, badgeId: 1 }, { unique: true });

module.exports = mongoose.model('UserBadge', badgeSchema);
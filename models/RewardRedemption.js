// models/RewardRedemption.js
const mongoose = require('mongoose');

const redemptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reward: { type: mongoose.Schema.Types.ObjectId, ref: 'Reward', required: true, index: true },

    // ✅ snapshot of the reward's brand at redemption time
    // (so if admin edits the reward later, we still know which brand it belonged to)
    rewardBrand: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    code: { type: String, required: true, unique: true, index: true },
    costPoints: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ['active', 'used', 'expired', 'cancelled'],
      default: 'active',
      index: true,
    },

    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },

    // ✅ which brand marked it used (audit trail)
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    cancelledAt: { type: Date, default: null },

    snapshot: {
      title: String,
      description: String,
      kind: String,
      brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },

    promoCode: { type: String, default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

redemptionSchema.index({ user: 1, reward: 1, status: 1 });

module.exports = mongoose.model('RewardRedemption', redemptionSchema);
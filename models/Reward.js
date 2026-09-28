// models/Reward.js
const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    image: { type: String, default: '' },
    costPoints: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: null },
    perUserLimit: { type: Number, default: 1 },
    active: { type: Boolean, default: true },
    kind: {
      type: String,
      enum: ['promo_code', 'brand_perk', 'tdc_card_discount'],
      default: 'promo_code',
    },
    validDays: { type: Number, default: 30 },
  },
  { timestamps: true }
);

// ✅ Index for fast "rewards for this brand" queries
rewardSchema.index({ brand: 1, active: 1 });
rewardSchema.index({ active: 1, costPoints: 1 });

module.exports = mongoose.model('Reward', rewardSchema);
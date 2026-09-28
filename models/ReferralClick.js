// models/ReferralClick.js
const mongoose = require('mongoose');

const referralClickSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, index: true },
    referrer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    channel: {
      type: String,
      enum: ['ig', 'wa', 'tt', 'copy', 'direct', 'unknown'],
      default: 'unknown',
    },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

referralClickSchema.index({ referrer: 1, at: -1 });
referralClickSchema.index({ code: 1, at: -1 });

module.exports = mongoose.model('ReferralClick', referralClickSchema);
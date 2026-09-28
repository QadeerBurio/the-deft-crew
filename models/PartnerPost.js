// models/PartnerPost.js
const mongoose = require('mongoose');

const partnerPostSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['instagram', 'tiktok', 'youtube', 'twitter', 'linkedin', 'other'],
      required: true,
    },
    url: { type: String, required: true },
    screenshotUrl: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reach: {
      type: String,
      enum: ['posted', '1k', '5k'],
      default: 'posted',
    },
    points: { type: Number, default: 0 },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
  },
  { timestamps: true }
);

partnerPostSchema.index({ user: 1, createdAt: -1 });
partnerPostSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PartnerPost', partnerPostSchema);
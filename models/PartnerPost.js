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
    // P2-5 (additive): kind "moment" = a campus moment (photo + caption, from the ambassador hub); "link" (missing on
    // older posts) = a link to a social post, which still needs platform and url
    kind: { type: String, enum: ['link', 'moment'], default: undefined },
    caption: { type: String, default: undefined, maxlength: 500 },
    imageUrl: { type: String, default: undefined },
    platform: {
      type: String,
      enum: ['instagram', 'tiktok', 'youtube', 'twitter', 'linkedin', 'other'],
      required: function () { return this.kind !== 'moment'; },
    },
    url: { type: String, required: function () { return this.kind !== 'moment'; } },
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
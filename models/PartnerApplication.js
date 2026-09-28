// models/PartnerApplication.js
const mongoose = require('mongoose');

const partnerApplicationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    university: { type: String, required: true, trim: true },
    why: { type: String, required: true, maxlength: 2000 },
    handle: { type: String, default: '' },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
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

partnerApplicationSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PartnerApplication', partnerApplicationSchema);
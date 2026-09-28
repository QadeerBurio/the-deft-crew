// models/Campaign.js
const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followerPercent: { type: Number, required: true, min: 0, max: 100 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    cap: { type: Number, default: null },
    status: {
      type: String,
      enum: ['draft', 'live', 'ended'],
      default: 'draft',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Campaign', campaignSchema);
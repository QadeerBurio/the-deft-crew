// models/EngagementEvent.js
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, index: true },
    feature: { type: String, default: null },
    dayKey: { type: String, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    source: { type: String, enum: ['server', 'client'], default: 'server' },
    dedupeKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

eventSchema.index({ user: 1, createdAt: -1 });
eventSchema.index({ name: 1, dayKey: 1 });
// TTL: 400 days
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model('EngagementEvent', eventSchema);
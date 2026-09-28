// models/PointsLedger.js
const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    reason: { type: String, required: true, index: true },

    // Either an ObjectId OR a descriptive string
    actor: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    actorRole: {
      type: String,
      enum: [
        'self',
        'system',
        'admin',
        'feature',
        'reward',
        'mission',
        'referral',
        'badge',
      ],
      default: 'system',
    },

    // What triggered the award: 'mission:discounts', 'reward', 'referral', etc.
    refType: { type: String, default: null, index: true },
    refId: { type: String, default: null },

    // Idempotency — only ONE of these is set per row
    idemKey: { type: String, default: null },
    dedupeKey: { type: String, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

ledgerSchema.index({ user: 1, createdAt: -1 });
ledgerSchema.index({ reason: 1, createdAt: -1 });

ledgerSchema.index(
  { idemKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idemKey: { $type: 'string' } },
    name: 'idemKey_unique_when_present',
  }
);

ledgerSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string' } },
    name: 'dedupeKey_unique_when_present',
  }
);

module.exports = mongoose.model('PointsLedger', ledgerSchema);
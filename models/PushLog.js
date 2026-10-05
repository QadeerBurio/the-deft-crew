// models/PushLog.js
const mongoose = require('mongoose');

const pushLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true, index: true },
    priority: { type: Number, default: 0 },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
     // ✅ Mood icon key (used to build the icon URL)
    mood: { type: String, default: 'sorted', index: true },

    dayKey: { type: String, index: true },
    weekKey: { type: String, index: true },
    sentAt: { type: Date, default: Date.now, index: true },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },

    ticketId: { type: String, default: null, index: true },
    receiptStatus: {
      type: String,
      enum: ['pending', 'ok', 'error', 'unknown'],
      default: 'pending',
    },
    receiptError: { type: String, default: null },

    tokens: [{ type: String }],
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed'],
      default: 'queued',
      index: true,
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

pushLogSchema.index({ user: 1, createdAt: -1 });
pushLogSchema.index({ ticketId: 1 }, { sparse: true });

module.exports = mongoose.model('PushLog', pushLogSchema);
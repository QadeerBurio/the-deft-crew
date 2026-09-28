// models/SocialNotification.js
const mongoose = require('mongoose');

const socialNotificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: { type: String, required: true },
    text: { type: String, default: '' },

    // ✅ Mood drives the in-app banner emoji — MUST be here
    mood: {
      type: String,
      default: 'sorted',
      enum: [
        'sorted', 'excited', 'sleepy', 'panic', 'sus', 'cheeky',
        'shook', 'hype', 'smug', 'shock', 'broke', 'money', 'ghost', 'urgent',
      ],
    },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    link: { type: String, default: null },

    relatedId: { type: mongoose.Schema.Types.ObjectId, default: null },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', default: null },

    status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'accepted' },
    isProcessed: { type: Boolean, default: false },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

socialNotificationSchema.index({ recipient: 1, createdAt: -1 });
socialNotificationSchema.index({ recipient: 1, readBy: 1 });

module.exports = mongoose.model('SocialNotification', socialNotificationSchema);
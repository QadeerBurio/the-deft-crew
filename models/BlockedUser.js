const mongoose = require('mongoose');

const BlockedUserSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  blockedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Unique compound index to prevent duplicate blocks
BlockedUserSchema.index({ userId: 1, blockedUserId: 1 }, { unique: true });

module.exports = mongoose.model('BlockedUser', BlockedUserSchema);
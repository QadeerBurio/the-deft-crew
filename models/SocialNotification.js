// models/SocialNotification.js - COMPLETE
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['like', 'comment', 'request', 'alert', 'connection_accepted', 'request_declined'],
    required: true 
  },
  text: { type: String, required: true },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
  relatedId: { type: mongoose.Schema.Types.ObjectId },
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'declined'], 
    default: 'pending' 
  },
  isProcessed: { type: Boolean, default: false },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

// Add compound index to prevent duplicate pending requests
notificationSchema.index({ 
  recipient: 1, 
  sender: 1, 
  type: 1, 
  status: 1 
});

// Index for performance
notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('SocialNotification', notificationSchema);
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['like', 'comment', 'request', 'alert'],
    required: true 
  },
  text: { type: String, required: true },
  postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }, // Add this field for post references
  relatedId: { type: mongoose.Schema.Types.ObjectId }, // Keep for backward compatibility
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'declined'], 
    default: 'pending' 
  },
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SocialNotification', notificationSchema);
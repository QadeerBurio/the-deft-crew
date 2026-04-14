const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  author: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  image: { 
    type: String, 
    required: true 
  },
  caption: {
    type: String,
    maxLength: 500
  },
  likes: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  comments: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }],
  seenBy: [{
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  expiresAt: { 
    type: Date, 
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) 
  }
}, { timestamps: true });

// Index for efficient queries
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ author: 1, expiresAt: -1 });

module.exports = mongoose.model('Story', storySchema);
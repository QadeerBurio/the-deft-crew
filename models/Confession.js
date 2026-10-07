// models/Confession.js
const mongoose = require('mongoose');

const ConfessionSchema = new mongoose.Schema({
  authorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    select: false // Always hide author identity
  },
  text: { 
    type: String,
    default: ""
  },
  image: { 
    type: String,
    default: ""
  },
  university: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'University',
    required: true
  },
  location: { 
    type: String, 
    default: "Karachi Campus"
  },
  // 'public' = everyone, 'campus' = only students of the same university.
  // Old documents have no value → treated as public everywhere ($ne: 'campus').
  visibility: {
    type: String,
    enum: ['public', 'campus'],
    default: 'public',
  },
  likes: { 
    type: Number, 
    default: 0 
  },
  likedBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],

  // ============================================
  // ✅ COMMENTS with parentComment + mentions
  // ============================================
  comments: [{
    user: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      required: true
    },
    text: { 
      type: String, 
      required: true,
      trim: true
    },
    // Parent comment for threading
    parentComment: { 
      type: mongoose.Schema.Types.ObjectId, 
      default: null 
    },
    // Mentioned user IDs
    mentions: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User' 
    }],
    createdAt: { 
      type: Date, 
      default: Date.now 
    }
  }],

  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Indexes for better query performance
ConfessionSchema.index({ createdAt: -1 });
ConfessionSchema.index({ university: 1, createdAt: -1 });
ConfessionSchema.index({ authorId: 1 });
ConfessionSchema.index({ university: 1, visibility: 1, createdAt: -1 });

module.exports = mongoose.model('Confession', ConfessionSchema);
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
    },
    // confession safety (plan P4-1): missing = live (every comment written before this)
    status: { type: String, enum: ['live', 'pending', 'hidden', 'removed'] },
    reportCount: { type: Number, default: 0 },
  }],

  // ============================================
  // confession safety (plan P4-1, flag confessionSafety). All optional: a confession written before this has no
  // status and counts as live everywhere.
  //   live     shown as before
  //   pending  held by the pre-post check (moderation unavailable, self-harm signal): only its author sees it
  //   hidden   hidden after reports, waiting for the re-check or more reports
  //   removed  confirmed as breaking the rules
  // ============================================
  status: { type: String, enum: ['live', 'pending', 'hidden', 'removed'] },
  statusReason: { type: String, default: undefined },
  statusAt: { type: Date },
  reportCount: { type: Number, default: 0 },
  // reporters (unique), never sent to anyone
  reportedBy: { type: [mongoose.Schema.Types.ObjectId], select: false, default: undefined },

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
ConfessionSchema.index({ status: 1, createdAt: -1 });

// What everyone may see: no status (older confessions) or "live". Used by every reader of the feed.
ConfessionSchema.statics.LIVE = { $or: [{ status: { $exists: false } }, { status: null }, { status: 'live' }] };
ConfessionSchema.statics.isLive = (doc) => !doc?.status || doc.status === 'live';

module.exports = mongoose.model('Confession', ConfessionSchema);
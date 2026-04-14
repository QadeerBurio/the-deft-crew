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
  likes: { 
    type: Number, 
    default: 0 
  },
  likedBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  comments: [{
    user: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      required: true
    },
    text: { 
      type: String, 
      required: true 
    },
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

// Index for better query performance
ConfessionSchema.index({ university: 1, createdAt: -1 });
ConfessionSchema.index({ authorId: 1 });
ConfessionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Confession', ConfessionSchema);
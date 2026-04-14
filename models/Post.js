// models/Post.js
const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  author: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  content: { 
    type: String,
    default: ""
  },
  category: { 
    type: String, 
    enum: ["General", "Events", "Opportunities", "Discounts", "Social"], 
    default: "General" 
  },
  image: { 
    type: String,
    default: ""
  },
  location: {
    type: String,
    default: "Karachi"
  },
  // Poll feature
  poll: [{
    option: { type: String, required: true },
    votes: { type: Number, default: 0 },
    votedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  }],
  // Discount feature (for Discounts category)
  discount: {
    code: { type: String },
    expiryDate: { type: Date },
    terms: { type: String }
  },
  // Event feature (for Events category)
  eventDate: { type: Date },
  // Engagement
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  viewedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  }],
  createdAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Indexes for better performance
PostSchema.index({ createdAt: -1 });
PostSchema.index({ category: 1 });
PostSchema.index({ author: 1 });

module.exports = mongoose.model('Post', PostSchema);
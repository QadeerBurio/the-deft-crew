const mongoose = require('mongoose');

const inquirySchema = new mongoose.Schema({
  listingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'resolved', 'closed'],
    default: 'active'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Ensure unique inquiry per user per listing
inquirySchema.index({ listingId: 1, userId: 1 }, { unique: true });

inquirySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Inquiry', inquirySchema);
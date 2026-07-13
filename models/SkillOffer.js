const mongoose = require('mongoose');

const skillOfferSchema = new mongoose.Schema({
  listingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
    index: true
  },
  offerorId: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'withdrawn'],
    default: 'pending'
  },
  message: {
    type: String,
    trim: true
  },
  // For barter: what skill they're offering
  offeredSkillName: {
    type: String,
    trim: true
  },
  offeredSkillLevel: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert']
  },
  // For paid: proposed price
  proposedPrice: {
    type: Number,
    min: 0
  },
  // For job: why they're a good fit
  applicationNotes: {
    type: String,
    trim: true
  },
  // Track if this offer created a match
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Match'
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

// Index for fast lookups
skillOfferSchema.index({ listingId: 1, status: 1 });
skillOfferSchema.index({ offerorId: 1, listingId: 1 });

// Pre-save middleware to update updatedAt
skillOfferSchema.pre('save', function(next) {
  this.updatedAt = new Date();
//   next();
});

module.exports = mongoose.model('SkillOffer', skillOfferSchema);
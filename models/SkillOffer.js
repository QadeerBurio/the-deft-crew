// models/SkillOffer.js
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
  offeredSkillName: {
    type: String,
    trim: true
  },
  offeredSkillLevel: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert']
  },
  proposedPrice: {
    type: Number,
    min: 0
  },
  applicationNotes: {
    type: String,
    trim: true
  },
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

// Indexes for fast lookups
skillOfferSchema.index({ listingId: 1, status: 1 });
skillOfferSchema.index({ offerorId: 1, listingId: 1 });
skillOfferSchema.index({ listingId: 1, offerorId: 1, status: 1 });

// Pre-save middleware to update updatedAt
skillOfferSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('SkillOffer', skillOfferSchema);
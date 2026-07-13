const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  listingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
    index: true
  },
  offerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SkillOffer',
    required: true
  },
  listingOwnerId: {
    type: String,
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
    enum: ['active', 'completed', 'cancelled'],
    default: 'active'
  },
  // For chat integration
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation'
  },
  acceptedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: Date,
  cancelledAt: Date,
  cancellationReason: String
}, {
  timestamps: true
});

// Ensure unique match per listing-offer
matchSchema.index({ listingId: 1, offerId: 1 }, { unique: true });

module.exports = mongoose.model('Match', matchSchema);
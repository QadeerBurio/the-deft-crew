// routes/skillOffer.routes.js
const express = require('express');
const router = express.Router();
const SkillOffer = require('../models/SkillOffer');
const Listing = require('../models/Listing');
const Match = require('../models/Match');
const auth = require('../middleware/auth.middleware');
const { Conversation } = require('../models/Chat');
const mongoose = require('mongoose');

// Helper to get user ID consistently
const getUserId = (req) => {
  return req.userId || req.user?._id || req.user?.id || req.user?.userId;
};

// ==================== CREATE OFFER ====================
router.post('/', auth, async (req, res) => {
  try {
    const { listingId, message, offeredSkillName, offeredSkillLevel, proposedPrice, applicationNotes } = req.body;
    const offerorId = getUserId(req);

    if (!offerorId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    // Check if listing exists
    const listing = await Listing.findById(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Check if listing is open
    if (listing.status !== 'open') {
      return res.status(400).json({ error: 'This listing is no longer accepting offers' });
    }

    // Check if user is the owner - FIXED comparison
    if (listing.ownerId.toString() === offerorId.toString()) {
      return res.status(400).json({ error: 'You cannot offer on your own listing' });
    }

    // Check for existing pending offer
    const existingOffer = await SkillOffer.findOne({
      listingId,
      offerorId: offerorId.toString(),
      status: { $in: ['pending', 'accepted'] }
    });

    if (existingOffer) {
      return res.status(409).json({ error: 'You already have a pending offer for this listing' });
    }

    // Create the offer
    const offer = new SkillOffer({
      listingId,
      offerorId: offerorId.toString(),
      message,
      offeredSkillName,
      offeredSkillLevel,
      proposedPrice,
      applicationNotes
    });

    await offer.save();

    res.status(201).json({
      success: true,
      message: 'Offer submitted successfully',
      offer
    });

  } catch (err) {
    console.error('Error creating offer:', err);
    res.status(500).json({ error: err.message || 'Failed to create offer' });
  }
});

// ==================== GET OFFERS FOR LISTING ====================
router.get('/listing/:listingId', auth, async (req, res) => {
  try {
    const { listingId } = req.params;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const listing = await Listing.findById(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // FIXED: Convert both to strings for comparison
    const listingOwnerId = listing.ownerId.toString();
    const currentUserId = userId.toString();

    // Only listing owner can view all offers
    if (listingOwnerId !== currentUserId) {
      console.log('Auth failed - Listing owner:', listingOwnerId, 'Current user:', currentUserId);
      return res.status(403).json({ 
        error: 'Unauthorized: Only the listing owner can view offers',
        debug: { listingOwnerId, currentUserId }
      });
    }

    // Fetch offers with populated data
    const offers = await SkillOffer.find({ listingId })
      .sort({ createdAt: -1 })
      .populate('offerorId', 'name email profileImage');

    res.json({
      success: true,
      offers
    });

  } catch (err) {
    console.error('Error fetching offers:', err);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// ==================== GET USER'S OFFERS ====================
router.get('/my-offers', auth, async (req, res) => {
  try {
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const offers = await SkillOffer.find({ offerorId: userId.toString() })
      .sort({ createdAt: -1 })
      .populate('listingId', 'title type status ownerId skillOffered skillWanted')
      .populate('matchId');

    res.json({
      success: true,
      offers
    });

  } catch (err) {
    console.error('Error fetching my offers:', err);
    res.status(500).json({ error: 'Failed to fetch your offers' });
  }
});

// ==================== UPDATE OFFER STATUS ====================
router.patch('/:offerId/status', auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const { status } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be "accepted" or "rejected"' });
    }

    const offer = await SkillOffer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    // Check if offer is still pending
    if (offer.status !== 'pending') {
      return res.status(400).json({ error: 'This offer has already been processed' });
    }

    // Get the listing
    const listing = await Listing.findById(offer.listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // FIXED: Convert both to strings for comparison
    if (listing.ownerId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You are not the listing owner' });
    }

    // Update offer status
    offer.status = status;
    await offer.save();

    // If accepted, create a match
    let match = null;
    if (status === 'accepted') {
      // Create a chat conversation
      const conversation = new Conversation({
        participants: [listing.ownerId.toString(), offer.offerorId.toString()],
        lastMessage: 'Match created!',
        unreadCount: 0,
        lastActivity: new Date()
      });
      await conversation.save();

      // Create the match
      match = new Match({
        listingId: listing._id,
        offerId: offer._id,
        listingOwnerId: listing.ownerId.toString(),
        offerorId: offer.offerorId.toString(),
        conversationId: conversation._id,
        status: 'active',
        acceptedAt: new Date()
      });
      await match.save();

      // Update offer with matchId
      offer.matchId = match._id;
      await offer.save();

      // Update listing status to matched
      listing.status = 'matched';
      await listing.save();

      // Reject all other pending offers for this listing
      await SkillOffer.updateMany(
        { 
          listingId: listing._id, 
          _id: { $ne: offerId },
          status: 'pending' 
        },
        { status: 'rejected' }
      );
    }

    res.json({
      success: true,
      message: `Offer ${status}`,
      offer,
      match
    });

  } catch (err) {
    console.error('Error updating offer:', err);
    res.status(500).json({ error: err.message || 'Failed to update offer' });
  }
});

// ==================== WITHDRAW OFFER ====================
router.patch('/:offerId/withdraw', auth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const userId = getUserId(req);

    const offer = await SkillOffer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    // FIXED: Convert both to strings for comparison
    if (offer.offerorId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You are not the offeror' });
    }

    if (offer.status !== 'pending') {
      return res.status(400).json({ error: 'This offer cannot be withdrawn' });
    }

    offer.status = 'withdrawn';
    await offer.save();

    res.json({
      success: true,
      message: 'Offer withdrawn successfully',
      offer
    });

  } catch (err) {
    console.error('Error withdrawing offer:', err);
    res.status(500).json({ error: 'Failed to withdraw offer' });
  }
});

module.exports = router;
// routes/skillOffer.routes.js
const express = require('express');
const router = express.Router();
const SkillOffer = require('../models/SkillOffer');
const Listing = require('../models/Listing');
const Match = require('../models/Match');
const auth = require('../middleware/auth.middleware');
const { Conversation } = require('../models/Chat');
const mongoose = require('mongoose');
const attachProfessionalProfiles = require('../utils/attachProfessionalProfiles');

// Helper to get user ID consistently
const getUserId = (req) => {
  return req.userId || req.user?._id || req.user?.id || req.user?.userId;
};

// ==================== CREATE OFFER ====================
router.post('/', auth, async (req, res) => {
  try {
    const { 
      listingId, 
      message, 
      offeredSkillName, 
      offeredSkillLevel, 
      proposedPrice, 
      applicationNotes 
    } = req.body;
    
    const offerorId = getUserId(req);

    // ✅ FIX: Validate offerorId exists
    if (!offerorId) {
      return res.status(401).json({ 
        error: 'User authentication required',
        details: 'Please login to make an offer'
      });
    }

    // Convert to string for consistency
    const offerorIdStr = offerorId.toString();

    // Check if listing exists
    const listing = await Listing.findById(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Check if listing is open
    if (listing.status !== 'open') {
      return res.status(400).json({ error: 'This listing is no longer accepting offers' });
    }

    // Check if user is the owner
    if (listing.ownerId.toString() === offerorIdStr) {
      return res.status(400).json({ error: 'You cannot offer on your own listing' });
    }

    // ✅ FIX: Check for existing pending offer more carefully
    const existingOffer = await SkillOffer.findOne({
      listingId: listingId,
      offerorId: offerorIdStr,
      status: { $in: ['pending', 'accepted'] }
    });

    if (existingOffer) {
      return res.status(409).json({ 
        error: 'You already have a pending offer for this listing',
        offerId: existingOffer._id,
        status: existingOffer.status
      });
    }

    // ✅ FIX: Create the offer with all fields properly set
    const offerData = {
      listingId: listingId,
      offerorId: offerorIdStr,
      status: 'pending',
      message: message || '',
    };

    // Add optional fields based on listing type
    if (offeredSkillName) offerData.offeredSkillName = offeredSkillName;
    if (offeredSkillLevel) offerData.offeredSkillLevel = offeredSkillLevel;
    if (proposedPrice) offerData.proposedPrice = parseFloat(proposedPrice);
    if (applicationNotes) offerData.applicationNotes = applicationNotes;

    const offer = new SkillOffer(offerData);

    console.log('Creating offer with data:', offerData);

    await offer.save();

    res.status(201).json({
      success: true,
      message: 'Offer submitted successfully',
      offer
    });

  } catch (err) {
    console.error('Error creating offer:', err);
    
    // ✅ FIX: Handle duplicate key error specifically
    if (err.code === 11000) {
      return res.status(409).json({ 
        error: 'You already have a pending offer for this listing',
        details: 'Duplicate offer detected'
      });
    }
    
    res.status(500).json({ 
      error: err.message || 'Failed to create offer'
    });
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

    // Convert both to strings for comparison
    const listingOwnerId = listing.ownerId.toString();
    const currentUserId = userId.toString();

    // Only listing owner can view all offers
    if (listingOwnerId !== currentUserId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the listing owner can view offers'
      });
    }

    // Fetch offers with populated data
    const offers = await SkillOffer.find({ listingId })
  .sort({ createdAt: -1 })
  .populate('offerorId', 'name email profileImage')
  .lean();

await attachProfessionalProfiles(offers, 'offerorId');

res.json({ success: true, offers });

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
  .populate({
    path: 'listingId',
    select: 'title type status ownerId skillOffered skillWanted',
    populate: { path: 'ownerId', select: 'name email profileImage role' }, // 👈 this was missing
  })
  .populate('matchId')
  .lean();

await attachProfessionalProfiles(offers, 'listingId.ownerId');

res.json({ success: true, offers });

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
      return res.status(400).json({ 
        error: 'This offer has already been processed',
        currentStatus: offer.status
      });
    }

    // Get the listing
    const listing = await Listing.findById(offer.listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Convert both to strings for comparison
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

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const offer = await SkillOffer.findById(offerId);
    if (!offer) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    // Convert both to strings for comparison
    if (offer.offerorId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized: You are not the offeror' });
    }

    if (offer.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This offer cannot be withdrawn',
        currentStatus: offer.status
      });
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
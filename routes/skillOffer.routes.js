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
const { createAndSendNotification, NotificationTemplates } = require('../utils/notificationHelper');
// ✅ FIX: Import the User model (was missing — caused "User is not defined")
const User = require('../models/User');
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

    if (!offerorId) {
      return res.status(401).json({ 
        error: 'User authentication required',
        details: 'Please login to make an offer'
      });
    }

    const offerorIdStr = offerorId.toString();

    // Check if listing exists
    const listing = await Listing.findById(listingId).populate('ownerId', 'name');
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    if (listing.status !== 'open') {
      return res.status(400).json({ error: 'This listing is no longer accepting offers' });
    }

    if (listing.ownerId._id.toString() === offerorIdStr) {
      return res.status(400).json({ error: 'You cannot offer on your own listing' });
    }

    // Check for existing pending offer
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

    // Create the offer
    const offerData = {
      listingId: listingId,
      offerorId: offerorIdStr,
      status: 'pending',
      message: message || '',
    };

    if (offeredSkillName) offerData.offeredSkillName = offeredSkillName;
    if (offeredSkillLevel) offerData.offeredSkillLevel = offeredSkillLevel;
    if (proposedPrice) offerData.proposedPrice = parseFloat(proposedPrice);
    if (applicationNotes) offerData.applicationNotes = applicationNotes;

    const offer = new SkillOffer(offerData);
    await offer.save();

    // ✅ SEND NOTIFICATION TO LISTING OWNER
    try {
      const offeror = await User.findById(offerorIdStr).select('name fullName');
      const offerorName = offeror?.fullName || offeror?.name || 'Someone';
      
      const template = NotificationTemplates.newOffer(offerorName, listing.title);
      
      await createAndSendNotification({
        recipientId: listing.ownerId._id,
        senderId: offerorIdStr,
        title: template.title,
        description: template.description,
        type: template.type,
        metadata: {
          listingId: listing._id.toString(),
          offerId: offer._id.toString(),
          screen: 'ManageOffers',
        },
        link: `/listing/${listing._id}`,
      });

      console.log('[SkillOffer] Notification sent to listing owner:', listing.ownerId._id);
    } catch (notifError) {
      console.error('[SkillOffer] Failed to send notification:', notifError);
      // Don't fail the request if notification fails
    }

    res.status(201).json({
      success: true,
      message: 'Offer submitted successfully',
      offer
    });

  } catch (err) {
    console.error('Error creating offer:', err);
    
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

    const listingOwnerId = listing.ownerId.toString();
    const currentUserId = userId.toString();

    if (listingOwnerId !== currentUserId) {
      return res.status(403).json({ 
        error: 'Unauthorized: Only the listing owner can view offers'
      });
    }

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
        populate: { path: 'ownerId', select: 'name email profileImage role' },
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

    if (offer.status !== 'pending') {
      return res.status(400).json({ 
        error: 'This offer has already been processed',
        currentStatus: offer.status
      });
    }

    const listing = await Listing.findById(offer.listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

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

    // ✅ SEND NOTIFICATION TO OFFEROR
    try {
      const owner = await User.findById(userId).select('name fullName');
      const ownerName = owner?.fullName || owner?.name || 'The listing owner';
      
      const template = status === 'accepted' 
        ? NotificationTemplates.offerAccepted(ownerName, listing.title)
        : NotificationTemplates.offerRejected(ownerName, listing.title);
      
      await createAndSendNotification({
        recipientId: offer.offerorId,
        senderId: userId,
        title: template.title,
        description: template.description,
        type: template.type,
        metadata: {
          listingId: listing._id.toString(),
          offerId: offer._id.toString(),
          matchId: match?._id?.toString(),
          screen: status === 'accepted' ? 'MatchChat' : 'MyOffers',
        },
        link: status === 'accepted' ? `/match/${match?._id}` : `/listing/${listing._id}`,
      });

      console.log('[SkillOffer] Status notification sent to offeror:', offer.offerorId);
    } catch (notifError) {
      console.error('[SkillOffer] Failed to send status notification:', notifError);
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
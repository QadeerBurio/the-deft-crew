const express = require('express');
const router = express.Router();
const Inquiry = require('../models/Inquiry');
const Listing = require('../models/Listing');
const auth = require('../middleware/auth.middleware');
const { Conversation, Message } = require('../models/Chat');

// ==================== START INQUIRY ====================
router.post('/', auth, async (req, res) => {
  try {
    const { listingId, userId, message } = req.body;
    const authenticatedUserId = req.userId || req.user?._id || req.user?.id;

    const actualUserId = userId || authenticatedUserId;

    if (!actualUserId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    // Check if listing exists
    const listing = await Listing.findById(listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Check if user is the owner
    if (listing.ownerId === actualUserId) {
      return res.status(400).json({ error: 'You cannot inquire about your own listing' });
    }

    // Check for existing inquiry
    let inquiry = await Inquiry.findOne({
      listingId,
      userId: actualUserId,
      status: 'active'
    });

    if (inquiry) {
      // If exists, add message to existing conversation
      const newMessage = new Message({
        conversationId: inquiry.conversationId,
        sender: actualUserId,
        text: message,
        messageType: 'text'
      });
      await newMessage.save();

      await Conversation.findByIdAndUpdate(inquiry.conversationId, {
        lastMessage: message,
        lastActivity: new Date()
      });

      return res.json({
        success: true,
        thread: inquiry,
        message: 'Added to existing conversation'
      });
    }

    // Create a new conversation for the inquiry
    const conversation = new Conversation({
      participants: [listing.ownerId, actualUserId],
      lastMessage: message,
      lastActivity: new Date()
    });
    await conversation.save();

    // Create the inquiry
    inquiry = new Inquiry({
      listingId,
      userId: actualUserId,
      conversationId: conversation._id,
      status: 'active'
    });
    await inquiry.save();

    // Add the first message
    const newMessage = new Message({
      conversationId: conversation._id,
      sender: actualUserId,
      text: message,
      messageType: 'text'
    });
    await newMessage.save();

    res.status(201).json({
      success: true,
      thread: inquiry,
      conversation
    });

  } catch (err) {
    console.error('Error starting inquiry:', err);
    res.status(500).json({ error: err.message || 'Failed to start inquiry' });
  }
});

// ==================== GET INQUIRY FOR LISTING AND USER ====================
router.get('/listing/:listingId/user/:userId', auth, async (req, res) => {
  try {
    const { listingId, userId } = req.params;
    const authenticatedUserId = req.userId || req.user?._id || req.user?.id;

    // Ensure user is requesting their own inquiry
    if (userId !== authenticatedUserId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const inquiry = await Inquiry.findOne({
      listingId,
      userId,
      status: 'active'
    }).populate('conversationId');

    if (!inquiry) {
      return res.status(404).json({ error: 'No inquiry found' });
    }

    res.json(inquiry);

  } catch (err) {
    console.error('Error fetching inquiry:', err);
    res.status(500).json({ error: 'Failed to fetch inquiry' });
  }
});

module.exports = router;
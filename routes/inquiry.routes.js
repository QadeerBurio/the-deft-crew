// routes/inquiry.routes.js
const express = require('express');
const router = express.Router();
const Inquiry = require('../models/Inquiry');
const Listing = require('../models/Listing');
const User = require('../models/User');
const auth = require('../middleware/auth.middleware');
const { Conversation, Message } = require('../models/Chat');
const { createAndSendNotification, NotificationTemplates } = require('../utils/notificationHelper');

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
    const listing = await Listing.findById(listingId).populate('ownerId', 'name fullName');
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }

    // Check if user is the owner
    const listingOwnerId = listing.ownerId._id?.toString() || listing.ownerId.toString();
    if (listingOwnerId === actualUserId.toString()) {
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
        lastMessageSender: actualUserId,
        lastMessageTime: new Date(),
        lastActivity: new Date()
      });

      // ✅ SEND NOTIFICATION TO LISTING OWNER
      try {
        const inquirer = await User.findById(actualUserId).select('name fullName');
        const inquirerName = inquirer?.fullName || inquirer?.name || 'Someone';
        
        const template = NotificationTemplates.newInquiry(inquirerName, listing.title);
        
        await createAndSendNotification({
          recipientId: listingOwnerId,
          senderId: actualUserId,
          title: template.title,
          description: message.length > 100 ? message.slice(0, 100) + '...' : message,
          type: 'Message',
          metadata: {
            listingId: listing._id.toString(),
            conversationId: inquiry.conversationId.toString(),
            inquiryId: inquiry._id.toString(),
            screen: 'InquiryChat',
          },
          link: `/inquiry/${inquiry._id}`,
        });
      } catch (notifError) {
        console.error('[Inquiry] Failed to send notification:', notifError);
      }

      return res.json({
        success: true,
        thread: inquiry,
        message: 'Added to existing conversation'
      });
    }

    // Create a new conversation for the inquiry
    const conversation = new Conversation({
      participants: [listingOwnerId, actualUserId],
      lastMessage: message,
      lastMessageSender: actualUserId,
      lastMessageTime: new Date(),
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

    // ✅ SEND NOTIFICATION TO LISTING OWNER
    try {
      const inquirer = await User.findById(actualUserId).select('name fullName');
      const inquirerName = inquirer?.fullName || inquirer?.name || 'Someone';
      
      const template = NotificationTemplates.newInquiry(inquirerName, listing.title);
      
      await createAndSendNotification({
        recipientId: listingOwnerId,
        senderId: actualUserId,
        title: template.title,
        description: message.length > 100 ? message.slice(0, 100) + '...' : message,
        type: 'Message',
        metadata: {
          listingId: listing._id.toString(),
          conversationId: conversation._id.toString(),
          inquiryId: inquiry._id.toString(),
          screen: 'InquiryChat',
        },
        link: `/inquiry/${inquiry._id}`,
      });

      console.log('[Inquiry] Notification sent to listing owner:', listingOwnerId);
    } catch (notifError) {
      console.error('[Inquiry] Failed to send notification:', notifError);
    }

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

// ==================== GET MY INQUIRIES ====================
router.get('/my-inquiries', auth, async (req, res) => {
  try {
    const userId = req.userId || req.user?._id || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const inquiries = await Inquiry.find({
      userId: userId.toString(),
      status: { $in: ['active', 'resolved'] }
    })
      .sort({ updatedAt: -1 })
      .populate({
        path: 'listingId',
        select: 'title type status ownerId',
        populate: { path: 'ownerId', select: 'name profileImage' }
      })
      .populate('conversationId', 'lastMessage lastActivity')
      .lean();

    res.json({ inquiries });

  } catch (err) {
    console.error('Error fetching my inquiries:', err);
    res.status(500).json({ error: 'Failed to fetch inquiries' });
  }
});

module.exports = router;
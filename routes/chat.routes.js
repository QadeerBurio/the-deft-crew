// routes/chat.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const { Conversation, Message } = require('../models/Chat');
const Match = require('../models/Match');
const User = require('../models/User');

// Helper to get user ID consistently
const getUserId = (req) => {
  // Try all possible sources
  return req.userId || req.user?._id || req.user?.id || req.user?.userId;
};

// ==================== GET CONVERSATION FOR MATCH ====================
router.get('/match/:matchId', auth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    // Verify user is part of the match
    const listingOwnerId = match.listingOwnerId?._id || match.listingOwnerId;
    const offerorId = match.offerorId?._id || match.offerorId;
    
    if (listingOwnerId.toString() !== userId.toString() && 
        offerorId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Get or create conversation
    let conversation = await Conversation.findById(match.conversationId)
      .populate('participants', 'name profileImage email role')
      .lean();

    if (!conversation) {
      // Create conversation if it doesn't exist
      const newConversation = new Conversation({
        participants: [listingOwnerId, offerorId],
        lastActivity: new Date()
      });
      await newConversation.save();
      
      // Update match with conversation ID
      match.conversationId = newConversation._id;
      await match.save();
      
      conversation = await Conversation.findById(newConversation._id)
        .populate('participants', 'name profileImage email role')
        .lean();
    }

    // Get messages with full sender data
    const messages = await Message.find({ conversationId: conversation._id })
      .populate('sender', 'name profileImage email role')
      .sort({ createdAt: 1 })
      .lean();

    // Mark messages as read
    await Message.updateMany(
      { 
        conversationId: conversation._id,
        'sender._id': { $ne: userId },
        isRead: false
      },
      { 
        isRead: true,
        readAt: new Date(),
        $addToSet: { readBy: userId }
      }
    );

    // Get other user info
    const otherParticipant = conversation.participants.find(
      p => p._id.toString() !== userId.toString()
    );

    res.json({
      success: true,
      conversation,
      messages,
      otherUser: otherParticipant || null
    });

  } catch (err) {
    console.error('Error fetching match conversation:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch conversation' });
  }
});

// ==================== GET MY MATCHES ====================
router.get('/my-matches', auth, async (req, res) => {
  try {
    const userId = getUserId(req);
    
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    const matches = await Match.find({
      $or: [
        { listingOwnerId: userId },
        { offerorId: userId }
      ],
      status: 'active'
    })
    .populate({
      path: 'listingId',
      select: 'title type skillOffered skillWanted status'
    })
    .populate({
      path: 'offerId',
      select: 'message status offeredSkillName proposedPrice'
    })
    .sort({ updatedAt: -1 })
    .lean();

    // Build response with user data
    const matchesWithDetails = await Promise.all(
      matches.map(async (match) => {
        // Find other participant
        const listingOwnerId = match.listingOwnerId?._id || match.listingOwnerId;
        const offerorId = match.offerorId?._id || match.offerorId;
        const otherUserId = listingOwnerId.toString() === userId.toString() 
          ? offerorId 
          : listingOwnerId;

        // Get other user data
        const otherUser = await User.findById(otherUserId)
          .select('name profileImage email role')
          .lean();

        // Get conversation
        let conversation = null;
        if (match.conversationId) {
          conversation = await Conversation.findById(match.conversationId)
            .populate('participants', 'name profileImage email role')
            .lean();
        }

        return {
          ...match,
          otherUser,
          conversation
        };
      })
    );

    res.json({
      success: true,
      matches: matchesWithDetails
    });

  } catch (err) {
    console.error('Error fetching matches:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch matches' });
  }
});

// ==================== GET MESSAGES FOR CONVERSATION ====================
router.get('/messages/:conversationId', auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    // Verify user is in conversation
    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const participants = conversation.participants.map(p => p.toString());
    if (!participants.includes(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    const messages = await Message.find({ conversationId })
      .populate('sender', 'name profileImage email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Mark messages as read
    const unreadMessages = messages.filter(msg => {
      const senderId = msg.sender?._id || msg.sender;
      return senderId && senderId.toString() !== userId.toString() && !msg.isRead;
    });

    if (unreadMessages.length > 0) {
      const messageIds = unreadMessages.map(msg => msg._id);
      await Message.updateMany(
        { _id: { $in: messageIds } },
        { 
          isRead: true,
          readAt: new Date(),
          $addToSet: { readBy: userId }
        }
      );
    }

    res.json({
      success: true,
      messages: messages.reverse(),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: await Message.countDocuments({ conversationId })
      }
    });

  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch messages' });
  }
});

// ==================== MARK MESSAGES AS READ ====================
router.patch('/messages/read', auth, async (req, res) => {
  try {
    const { conversationId, messageIds } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId required' });
    }

    const query = { 
      conversationId,
      isRead: false
    };

    if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
      query._id = { $in: messageIds };
    }

    const result = await Message.updateMany(
      query,
      { 
        isRead: true,
        readAt: new Date(),
        $addToSet: { readBy: userId }
      }
    );

    // Reset unread count in conversation
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { unreadCount: 0 }
    });

    res.json({
      success: true,
      message: 'Messages marked as read',
      updatedCount: result.modifiedCount
    });

  } catch (err) {
    console.error('Error marking messages read:', err);
    res.status(500).json({ error: err.message || 'Failed to mark messages as read' });
  }
});

module.exports = router;
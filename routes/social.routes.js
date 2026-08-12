// social.routes.js - COMPLETE FIXED VERSION with null safety

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Post = require('../models/Post');
const Confession = require('../models/Confession');
const User = require('../models/User');
const Story = require('../models/Story');
const Report = require('../models/Report');
const BlockedUser = require('../models/BlockedUser');
const Notification = require('../models/SocialNotification');
const createNotification = require('../utils/notificationHelper');
const { Conversation, Message } = require('../models/Chat');

// ============================================
// ============ REPORT ROUTES ================
// ============================================

/**
 * REPORT A POST
 * POST /api/social/posts/report/:postId
 */
router.post('/posts/report/:postId', auth, async (req, res) => {
  try {
    const { postId } = req.params;
    const { reason, description } = req.body;
    const userId = req.user._id;

    if (!reason) {
      return res.status(400).json({ error: "Please provide a reason for reporting" });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const existingReport = await Report.findOne({
      reporterId: userId,
      contentId: postId,
      contentType: 'Post',
      status: { $in: ['pending', 'under_review'] }
    });

    if (existingReport) {
      return res.status(400).json({ error: "You have already reported this post" });
    }

    const report = new Report({
      reporterId: userId,
      reportedUserId: post.author,
      contentId: postId,
      contentType: 'Post',
      reason,
      description: description || '',
      status: 'pending'
    });

    await report.save();

    res.status(201).json({
      success: true,
      message: "Report submitted successfully",
      reportId: report._id
    });

  } catch (err) {
    console.error("Report Post Error:", err);
    res.status(500).json({ error: "Failed to submit report" });
  }
});

/**
 * REPORT A COMMENT
 * POST /api/social/posts/comment/:postId/:commentId/report
 */
router.post('/posts/comment/:postId/:commentId/report', auth, async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const { reason, description } = req.body;
    const userId = req.user._id;

    if (!reason) {
      return res.status(400).json({ error: "Please provide a reason for reporting" });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const comment = post.comments.find(c => c._id.toString() === commentId);
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const existingReport = await Report.findOne({
      reporterId: userId,
      contentId: commentId,
      contentType: 'Comment',
      status: { $in: ['pending', 'under_review'] }
    });

    if (existingReport) {
      return res.status(400).json({ error: "You have already reported this comment" });
    }

    const report = new Report({
      reporterId: userId,
      reportedUserId: comment.user,
      contentId: commentId,
      contentType: 'Comment',
      reason,
      description: description || '',
      status: 'pending'
    });

    await report.save();

    res.status(201).json({
      success: true,
      message: "Comment reported successfully"
    });

  } catch (err) {
    console.error("Report Comment Error:", err);
    res.status(500).json({ error: "Failed to submit report" });
  }
});

/**
 * REPORT A USER
 * POST /api/social/user/report/:userId
 */
router.post('/user/report/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason, description } = req.body;
    const reporterId = req.user._id;

    if (!reason) {
      return res.status(400).json({ error: "Please provide a reason for reporting" });
    }

    if (userId === reporterId.toString()) {
      return res.status(400).json({ error: "You cannot report yourself" });
    }

    const reportedUser = await User.findById(userId);
    if (!reportedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingReport = await Report.findOne({
      reporterId: reporterId,
      reportedUserId: userId,
      contentType: 'User',
      status: { $in: ['pending', 'under_review'] }
    });

    if (existingReport) {
      return res.status(400).json({ error: "You have already reported this user" });
    }

    const report = new Report({
      reporterId: reporterId,
      reportedUserId: userId,
      contentType: 'User',
      reason,
      description: description || '',
      status: 'pending'
    });

    await report.save();

    res.status(201).json({
      success: true,
      message: "User reported successfully"
    });

  } catch (err) {
    console.error("Report User Error:", err);
    res.status(500).json({ error: "Failed to submit report" });
  }
});

// ============================================
// ============ BLOCK ROUTES ================
// ============================================

/**
 * BLOCK A USER
 * POST /api/social/user/block/:userId
 */
router.post('/user/block/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;

    if (userId === currentUserId.toString()) {
      return res.status(400).json({ error: "You cannot block yourself" });
    }

    const userToBlock = await User.findById(userId);
    if (!userToBlock) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingBlock = await BlockedUser.findOne({
      userId: currentUserId,
      blockedUserId: userId
    });

    if (existingBlock) {
      return res.status(400).json({ error: "User already blocked" });
    }

    const block = new BlockedUser({
      userId: currentUserId,
      blockedUserId: userId
    });

    await block.save();

    await User.findByIdAndUpdate(currentUserId, {
      $addToSet: { blockedUsers: userId }
    });

    await User.findByIdAndUpdate(currentUserId, {
      $pull: { connections: userId, sentRequests: userId, receivedRequests: userId }
    });

    await User.findByIdAndUpdate(userId, {
      $pull: { connections: currentUserId, sentRequests: currentUserId, receivedRequests: currentUserId }
    });

    await Notification.deleteMany({
      $or: [
        { recipient: currentUserId, sender: userId, isProcessed: false },
        { recipient: userId, sender: currentUserId, isProcessed: false }
      ]
    });

    res.json({
      success: true,
      message: "User blocked successfully"
    });

  } catch (err) {
    console.error("Block User Error:", err);
    res.status(500).json({ error: "Failed to block user" });
  }
});

/**
 * UNBLOCK A USER
 * POST /api/social/user/unblock/:userId
 */
router.post('/user/unblock/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;

    await BlockedUser.findOneAndDelete({
      userId: currentUserId,
      blockedUserId: userId
    });

    await User.findByIdAndUpdate(currentUserId, {
      $pull: { blockedUsers: userId }
    });

    res.json({
      success: true,
      message: "User unblocked successfully"
    });

  } catch (err) {
    console.error("Unblock User Error:", err);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

/**
 * GET BLOCKED USERS LIST
 * GET /api/social/user/blocked
 */
router.get('/user/blocked', auth, async (req, res) => {
  try {
    const blocks = await BlockedUser.find({ userId: req.user._id })
      .populate('blockedUserId', 'name profileImage headline');

    const blockedUsers = blocks.map(block => ({
      _id: block.blockedUserId?._id || null,
      name: block.blockedUserId?.name || 'Unknown User',
      profileImage: block.blockedUserId?.profileImage || '',
      headline: block.blockedUserId?.headline || '',
      blockedAt: block.createdAt
    }));

    res.json({ blockedUsers });

  } catch (err) {
    console.error("Get Blocked Users Error:", err);
    res.status(500).json({ error: "Failed to fetch blocked users" });
  }
});

// ============================================
// ============ ADMIN ROUTES ================
// ============================================

router.get('/admin/reports/pending-count', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const count = await Report.countDocuments({
      status: { $in: ['pending', 'under_review'] }
    });

    res.json({ pendingCount: count });

  } catch (err) {
    console.error("Get pending count error:", err);
    res.status(500).json({ error: "Failed to fetch count" });
  }
});

router.get('/admin/reports', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { status, limit = 50, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    let filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }

    const reports = await Report.find(filter)
      .populate('reporterId', 'name profileImage email')
      .populate('reportedUserId', 'name profileImage email accountStatus')
      .populate('resolvedBy', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Report.countDocuments(filter);

    res.json({
      reports,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (err) {
    console.error("Get Reports Error:", err);
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

router.get('/admin/reports/:reportId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const report = await Report.findById(req.params.reportId)
      .populate('reporterId', 'name profileImage email')
      .populate('reportedUserId', 'name profileImage email accountStatus');

    if (!report) {
      return res.status(404).json({ error: "Report not found" });
    }

    let content = null;
    if (report.contentType === 'Post' && report.contentId) {
      content = await Post.findById(report.contentId)
        .populate('author', 'name profileImage');
    } else if (report.contentType === 'Comment' && report.contentId) {
      const post = await Post.findOne({
        'comments._id': report.contentId
      }).populate('author', 'name');
      if (post) {
        const comment = post.comments.find(c => c._id.toString() === report.contentId.toString());
        content = { postId: post._id, postAuthor: post.author, comment };
      }
    }

    res.json({ report, content });

  } catch (err) {
    console.error("Get Report Details Error:", err);
    res.status(500).json({ error: "Failed to fetch report details" });
  }
});

router.put('/admin/reports/:reportId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { status, adminNotes, actionTaken } = req.body;
    const report = await Report.findById(req.params.reportId);

    if (!report) {
      return res.status(404).json({ error: "Report not found" });
    }

    report.status = status || report.status;
    report.adminNotes = adminNotes || report.adminNotes;
    report.actionTaken = actionTaken || report.actionTaken;

    if (status === 'resolved' || status === 'rejected') {
      report.resolvedAt = new Date();
      report.resolvedBy = req.user._id;
    }

    await report.save();

    res.json({
      success: true,
      message: "Report updated successfully",
      report
    });

  } catch (err) {
    console.error("Update Report Error:", err);
    res.status(500).json({ error: "Failed to update report" });
  }
});

router.post('/admin/reports/:reportId/action', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { action, reason } = req.body;
    const report = await Report.findById(req.params.reportId);

    if (!report) {
      return res.status(404).json({ error: "Report not found" });
    }

    const reportedUser = await User.findById(report.reportedUserId);
    if (!reportedUser) {
      return res.status(404).json({ error: "Reported user not found" });
    }

    let actionResult = {};

    switch (action) {
      case 'remove_content':
        if (report.contentType === 'Post' && report.contentId) {
          await Post.findByIdAndDelete(report.contentId);
          actionResult = { contentRemoved: true };
        } else if (report.contentType === 'Comment' && report.contentId) {
          const post = await Post.findOne({ 'comments._id': report.contentId });
          if (post) {
            post.comments = post.comments.filter(c => c._id.toString() !== report.contentId.toString());
            await post.save();
            actionResult = { commentRemoved: true };
          }
        }
        report.actionTaken = 'content_removed';
        break;

      case 'warn_user':
        await createNotification(
          reportedUser._id,
          req.user._id,
          'alert',
          `Warning: Your content has been reported for ${report.reason}. Please review our community guidelines.`,
          null
        );
        report.actionTaken = 'warning';
        actionResult = { warned: true };
        break;

      case 'suspend_user':
        reportedUser.accountStatus = 'suspended';
        reportedUser.suspensionReason = reason || `Reported for ${report.reason}`;
        reportedUser.suspensionExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await reportedUser.save();
        report.actionTaken = 'user_suspended';
        actionResult = { suspended: true };
        break;

      case 'ban_user':
        reportedUser.accountStatus = 'banned';
        reportedUser.suspensionReason = reason || `Permanently banned for ${report.reason}`;
        await reportedUser.save();
        report.actionTaken = 'user_banned';
        actionResult = { banned: true };
        break;

      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    report.status = 'resolved';
    report.resolvedAt = new Date();
    report.resolvedBy = req.user._id;
    await report.save();

    res.json({
      success: true,
      message: "Action taken successfully",
      report,
      actionResult
    });

  } catch (err) {
    console.error("Take Action Error:", err);
    res.status(500).json({ error: "Failed to take action" });
  }
});

router.get('/admin/reports/stats', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const stats = {
      pending: await Report.countDocuments({ status: 'pending' }),
      underReview: await Report.countDocuments({ status: 'under_review' }),
      resolved: await Report.countDocuments({ status: 'resolved' }),
      rejected: await Report.countDocuments({ status: 'rejected' }),
      total: await Report.countDocuments(),
      byReason: await Report.aggregate([
        { $group: { _id: '$reason', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      byContentType: await Report.aggregate([
        { $group: { _id: '$contentType', count: { $sum: 1 } } }
      ])
    };

    res.json(stats);

  } catch (err) {
    console.error("Get Report Stats Error:", err);
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
});

// ============================================
// ============ FEED WITH BLOCK CHECK ============
// ============================================

/**
 * GET FEED - FILTERS OUT BLOCKED USERS - COMPLETE FIX
 * GET /api/social/feed
 */
router.get('/feed', auth, async (req, res) => {
  try {
    const { category, search, limit = 20, before } = req.query;
    const userId = req.user._id;

    // Get blocked users
    const blockedUsers = await BlockedUser.find({ userId })
      .select('blockedUserId');
    const blockedUserIds = blockedUsers.map(b => b.blockedUserId ? b.blockedUserId.toString() : '').filter(id => id);

    // Get current user's connections
    const currentUser = await User.findById(userId).select('connections sentRequests receivedRequests');
    const userConnections = (currentUser?.connections || []).map(id => id ? id.toString() : '').filter(id => id);
    const userSentRequests = (currentUser?.sentRequests || []).map(id => id ? id.toString() : '').filter(id => id);

    let query = {};

    // Exclude posts from blocked users
    if (blockedUserIds.length > 0) {
      query.author = { $nin: blockedUserIds };
    }

    if (category && category !== "All") {
      query.category = category;
    }

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search, 'i');
      const matchingUsers = await User.find({ name: searchRegex }).select('_id');
      const matchingUserIds = matchingUsers.map(user => user._id ? user._id.toString() : '').filter(id => id);
      
      // Filter out blocked users from search
      const filteredUserIds = matchingUserIds.filter(id => !blockedUserIds.includes(id));
      
      query.$or = [
        { content: searchRegex },
        { author: { $in: filteredUserIds } }
      ];
    }

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    let posts = await Post.find(query)
      .populate({
        path: 'author',
        select: 'name profileImage university connections sentRequests receivedRequests',
        populate: { path: 'university', select: 'name' }
      })
      .populate({
        path: 'comments.user',
        select: 'name profileImage'
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    // ========== FIX: Filter out posts with null/undefined author ==========
    const validPosts = posts.filter(post => {
      return post && post.author !== null && post.author !== undefined;
    });

    // ========== FIX: Map posts with null safety ==========
    const postsWithStatus = validPosts.map(post => {
      try {
        const postObj = post.toObject ? post.toObject() : { ...post };
        const author = post.author;

        if (!author) {
          return null;
        }

        // SAFE: Get author ID with null checks
        let authorId = '';
        try {
          authorId = author._id ? author._id.toString() : '';
        } catch (err) {
          authorId = '';
        }

        const userIdStr = userId.toString();

        // Determine connection status
        let connectionStatus = 'none';
        if (authorId === userIdStr) {
          connectionStatus = 'self';
        } else if (userConnections.includes(authorId)) {
          connectionStatus = 'connected';
        } else if (userSentRequests.includes(authorId)) {
          connectionStatus = 'pending';
        } else if (author.receivedRequests && Array.isArray(author.receivedRequests)) {
          const hasReceived = author.receivedRequests.some(id => {
            try {
              return id && id.toString() === userIdStr;
            } catch (err) {
              return false;
            }
          });
          if (hasReceived) {
            connectionStatus = 'received';
          }
        }

        // SAFE: Build author object with null checks
        postObj.author = {
          _id: author._id || null,
          name: author.name || 'Unknown User',
          profileImage: author.profileImage || '',
          university: author.university || null,
          connectionStatus: connectionStatus,
          isConnected: connectionStatus === 'connected',
          isPending: connectionStatus === 'pending',
          isReceived: connectionStatus === 'received'
        };

        // SAFE: Check if viewed
        let hasViewed = false;
        try {
          if (post.viewedBy && Array.isArray(post.viewedBy)) {
            hasViewed = post.viewedBy.some(id => {
              try {
                return id && id.toString() === userIdStr;
              } catch (err) {
                return false;
              }
            });
          }
        } catch (err) {
          hasViewed = false;
        }
        postObj.hasViewed = hasViewed;

        // SAFE: Process likes - handle null/undefined
        try {
          if (postObj.likes && Array.isArray(postObj.likes)) {
            postObj.likes = postObj.likes.filter(like => like !== null && like !== undefined);
          } else {
            postObj.likes = [];
          }
        } catch (err) {
          postObj.likes = [];
        }

        // SAFE: Process comments - handle null/undefined
        try {
          if (postObj.comments && Array.isArray(postObj.comments)) {
            postObj.comments = postObj.comments.filter(comment => comment !== null && comment !== undefined);
          } else {
            postObj.comments = [];
          }
        } catch (err) {
          postObj.comments = [];
        }

        return postObj;
      } catch (err) {
        console.error('Error processing post:', err);
        return null;
      }
    }).filter(post => post !== null);

    const hasMore = posts.length === parseInt(limit);

    res.json({
      posts: postsWithStatus,
      hasMore: hasMore
    });

  } catch (err) {
    console.error("[Backend Error] Feed:", err.message);
    console.error("[Backend Error] Stack:", err.stack);
    res.status(500).json({
      error: "Failed to fetch feed results.",
      details: err.message
    });
  }
});

// ============================================
// ============ PROFILE WITH BLOCK CHECK ============
// ============================================

/**
 * GET USER PROFILE - WITH BLOCK CHECK
 * GET /api/social/profile/:userId
 */
router.get('/profile/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const currentUserId = req.user._id;

    // Check if current user has blocked this user
    const isBlocked = await BlockedUser.findOne({
      userId: currentUserId,
      blockedUserId: userId
    });

    if (isBlocked) {
      return res.status(403).json({
        error: "You have blocked this user",
        isBlocked: true
      });
    }

    // Check if this user has blocked current user
    const isBlockedByUser = await BlockedUser.findOne({
      userId: userId,
      blockedUserId: currentUserId
    });

    if (isBlockedByUser) {
      return res.status(403).json({
        error: "You have been blocked by this user",
        isBlocked: true
      });
    }

    // Get current user's connections
    const currentUser = await User.findById(currentUserId).select('connections sentRequests receivedRequests');
    const userConnections = (currentUser?.connections || []).map(id => id ? id.toString() : '').filter(id => id);
    const userSentRequests = (currentUser?.sentRequests || []).map(id => id ? id.toString() : '').filter(id => id);
    const userReceivedRequests = (currentUser?.receivedRequests || []).map(id => id ? id.toString() : '').filter(id => id);

    const profile = await User.findById(userId)
      .select('-password -email')
      .populate('university', 'name')
      .populate({
        path: 'connections',
        select: 'name profileImage username headline'
      });

    if (!profile) {
      return res.status(404).json({ error: "User not found" });
    }

    // Determine connection status
    let connectionStatus = 'none';
    const userIdStr = userId.toString();
    const currentUserIdStr = currentUserId.toString();

    if (userIdStr === currentUserIdStr) {
      connectionStatus = 'self';
    } else if (userConnections.includes(userIdStr)) {
      connectionStatus = 'connected';
    } else if (userSentRequests.includes(userIdStr)) {
      connectionStatus = 'pending';
    } else if (userReceivedRequests.includes(userIdStr)) {
      connectionStatus = 'received';
    }

    // Get posts - filter out if user is blocked
    const posts = await Post.find({ author: userId })
      .populate({
        path: 'author',
        select: 'name profileImage university connections sentRequests receivedRequests',
        populate: { path: 'university', select: 'name' }
      })
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage')
      .sort({ createdAt: -1 });

    const validPosts = posts.filter(post => post && post.author !== null && post.author !== undefined);

    const postsWithStatus = validPosts.map(post => {
      try {
        const postObj = post.toObject ? post.toObject() : { ...post };
        const author = post.author;
        if (!author) return null;

        let authorId = '';
        try {
          authorId = author._id ? author._id.toString() : '';
        } catch (err) {
          authorId = '';
        }

        const userIdStr = currentUserId.toString();

        let connectionStatus = 'none';
        if (authorId === userIdStr) {
          connectionStatus = 'self';
        } else if (userConnections.includes(authorId)) {
          connectionStatus = 'connected';
        } else if (userSentRequests.includes(authorId)) {
          connectionStatus = 'pending';
        } else if (author.receivedRequests && Array.isArray(author.receivedRequests)) {
          const hasReceived = author.receivedRequests.some(id => {
            try {
              return id && id.toString() === userIdStr;
            } catch (err) {
              return false;
            }
          });
          if (hasReceived) {
            connectionStatus = 'received';
          }
        }

        postObj.author = {
          _id: author._id || null,
          name: author.name || 'Unknown User',
          profileImage: author.profileImage || '',
          university: author.university || null,
          connectionStatus: connectionStatus,
          isConnected: connectionStatus === 'connected',
          isPending: connectionStatus === 'pending',
          isReceived: connectionStatus === 'received'
        };

        // SAFE: Process likes
        try {
          if (postObj.likes && Array.isArray(postObj.likes)) {
            postObj.likes = postObj.likes.filter(like => like !== null && like !== undefined);
          } else {
            postObj.likes = [];
          }
        } catch (err) {
          postObj.likes = [];
        }

        return postObj;
      } catch (err) {
        console.error('Error processing profile post:', err);
        return null;
      }
    }).filter(post => post !== null);

    const profileObj = profile.toObject ? profile.toObject() : { ...profile };
    profileObj.connectionStatus = connectionStatus;
    profileObj.isConnected = connectionStatus === 'connected';
    profileObj.isPending = connectionStatus === 'pending';
    profileObj.isReceived = connectionStatus === 'received';
    profileObj.connectionCount = profile.connections?.length || 0;
    profileObj.isBlocked = false;

    res.json({
      profile: profileObj,
      posts: postsWithStatus,
      connections: profile.connections || [],
      connectionStatus
    });

  } catch (err) {
    console.error("Profile Fetch Error:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: "Failed to fetch profile content", details: err.message });
  }
});

// ============================================
// ============ CREATE POST ================
// ============================================

router.post('/create-post', auth, async (req, res) => {
  try {
    const { content, category, image, poll, location } = req.body;

    if (!content && !image) {
      return res.status(400).json({ error: "Please add some text or an image to your post." });
    }

    const newPost = new Post({
      author: req.user._id,
      content: content?.trim(),
      category: category || "General",
      image: image || "",
      poll: poll || [],
      location: location || "Karachi"
    });

    await newPost.save();

    const populatedPost = await Post.findById(newPost._id)
      .populate({
        path: 'author',
        select: 'name profileImage university connections sentRequests receivedRequests',
        populate: { path: 'university', select: 'name' }
      });

    res.status(201).json(populatedPost);
  } catch (err) {
    console.error("[Backend Error] Create Post:", err.message);
    res.status(500).json({ error: "Database error: Could not save your post." });
  }
});

// --- Mark Post as Viewed ---
router.post('/posts/view/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const userId = req.user._id;
    
    if (!post.viewedBy.includes(userId)) {
      post.viewedBy.push(userId);
      await post.save();
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error("[Backend Error] Mark viewed:", err.message);
    res.status(500).json({ error: "Failed to mark post as viewed" });
  }
});

// --- Toggle Like on Post ---
router.put('/posts/like/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const userId = req.user._id;
    const isLiked = post.likes.includes(userId);

    if (isLiked) {
      post.likes = post.likes.filter(id => id.toString() !== userId.toString());
    } else {
      post.likes.push(userId);
      
      if (post.author.toString() !== userId.toString()) {
        await createNotification(
          post.author,
          req.user._id,
          'like',
          `${req.user.name} liked your post`,
          post._id
        );
      }
    }
    await post.save();
    
    const populatedPost = await Post.findById(post._id)
      .populate('likes', 'name profileImage');
    
    res.json({ 
      success: true, 
      likes: post.likes.length,
      liked: !isLiked,
      likedBy: populatedPost.likes
    });
  } catch (err) { 
    console.error("Like Error:", err);
    res.status(500).json({ message: "Server Error" }); 
  }
});

// --- Get Post Likes ---
router.get('/posts/likes/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('likes', 'name profileImage');
    
    if (!post) return res.status(404).json({ message: "Post not found" });
    
    res.json({ likes: post.likes });
  } catch (err) {
    console.error("Get Likes Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// --- Add Comment to Post ---
router.post('/posts/comment/:id', auth, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Comment text cannot be empty." });
    }

    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found." });

    const newComment = {
      user: req.user._id,
      text: text.trim(),
      createdAt: new Date()
    };

    post.comments.unshift(newComment);
    await post.save();

    const updatedPost = await Post.findById(req.params.id)
      .populate('comments.user', 'name profileImage');

    const previewText = text.length > 20 ? text.substring(0, 20) + "..." : text;
    if (post.author.toString() !== req.user._id.toString()) {
       await createNotification(
         post.author,
         req.user._id,
         'comment',
         `${req.user.name} commented: "${previewText}"`,
         post._id
       );
    }

    res.json({ success: true, comments: updatedPost.comments });
  } catch (err) { 
    console.error("Comment Logic Error:", err.message);
    res.status(500).json({ error: "Internal Server Error" }); 
  }
});

// --- Favorite Post ---
router.post('/posts/favorite/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const userId = req.user._id.toString();
    const alreadySaved = post.favorites.some(id => id.toString() === userId);

    if (alreadySaved) {
      post.favorites = post.favorites.filter(id => id.toString() !== userId);
    } else {
      post.favorites.push(userId);
    }

    await post.save();
    res.json({ success: true, favorites: post.favorites });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Favorite failed" });
  }
});

// --- Delete Comment from Post ---
router.delete('/posts/comment/:postId/:commentId', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found" });

    const comment = post.comments.find(c => c._id.toString() === req.params.commentId);
    if (!comment) return res.status(404).json({ error: "Comment not found" });

    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own comments" });
    }

    post.comments = post.comments.filter(c => c._id.toString() !== req.params.commentId);
    await post.save();

    res.json({ success: true, message: "Comment deleted" });
  } catch (err) {
    console.error("Delete Comment Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Delete Post ---
router.delete('/posts/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });

    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own posts" });
    }

    await post.deleteOne();
    res.json({ success: true, message: "Post deleted successfully" });
  } catch (err) {
    console.error("Delete Post Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Get Single Post ---
router.get('/posts/:id', auth, async (req, res) => {
  try {
    let postId = req.params.id;
    
    if (postId && typeof postId === 'object') {
      postId = postId._id || postId.toString();
    }
    
    const isValidObjectId = (id) => {
      if (!id) return false;
      const idStr = typeof id === 'string' ? id : String(id);
      return /^[0-9a-fA-F]{24}$/.test(idStr);
    };
    
    if (!isValidObjectId(postId)) {
      console.error('Invalid post ID format:', postId);
      return res.status(400).json({ error: "Invalid post ID format" });
    }
    
    const post = await Post.findById(postId)
      .populate('author', 'name profileImage connections sentRequests receivedRequests')
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage');
    
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    
    res.json(post);
  } catch (err) {
    console.error("Get Post Error:", err);
    console.error("Stack:", err.stack);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- USER PROFILE --------------------
// --- Get User's Confessions ---
router.get('/confessions/my-confessions', auth, async (req, res) => {
  try {
    const myConfessions = await Confession.find({ authorId: req.user.id })
      .populate('comments.user', 'name profileImage')
      .sort({ createdAt: -1 });
    res.json(myConfessions);
  } catch (err) {
    console.error("Confessions Fetch Error:", err);
    res.status(500).json({ error: "Could not fetch your confessions." });
  }
});

// --- Get Confession Likes ---
router.get('/confessions/likes/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    if (!confession) return res.status(404).json({ message: "Confession not found" });
    
    const users = await User.find({ _id: { $in: confession.likedBy } })
      .select('name profileImage');
    
    res.json({ likes: users });
  } catch (err) {
    console.error("Get Confession Likes Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// --- Update Profile ---
router.put('/profile/update', auth, async (req, res) => {
  try {
    const { name, headline, bio, school, degree, rollNo } = req.body;

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      {
        $set: {
          name,
          headline,
          bio,
          rollNo,
          education: [{ school, degree }]
        }
      },
      { new: true, runValidators: true }
    )
    .populate('university', 'name')
    .select('-password');

    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: updatedUser
    });
  } catch (err) {
    console.error("[Update Error]:", err.message);
    res.status(500).json({ error: "Internal Server Error during update" });
  }
});

// FIXED: Delete Confession Route
// --- Delete Confession ---
router.delete('/confessions/:id', auth, async (req, res) => {
  try {
    // IMPORTANT: Use .select('+authorId') to include the hidden field
    const confession = await Confession.findById(req.params.id).select('+authorId');
    
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    // Check if authorId exists and matches the current user
    if (!confession.authorId) {
      return res.status(404).json({ error: "Confession author not found" });
    }

    if (confession.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own confessions" });
    }

    await confession.deleteOne();
    res.status(200).json({ message: "Confession deleted successfully" });
  } catch (err) {
    console.error("Delete Confession Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// FIXED: Get User's Own Confessions
router.get('/confessions/my-confessions', auth, async (req, res) => {
  try {
    // IMPORTANT: Use .select('+authorId') to include the hidden field
    const myConfessions = await Confession.find({ authorId: req.user.id })
      .select('+authorId') // Include authorId for ownership check
      .populate('comments.user', 'name profileImage')
      .sort({ createdAt: -1 });
    
    // Remove authorId from response but keep it for internal use
    const sanitizedConfessions = myConfessions.map(confession => {
      const obj = confession.toObject();
      delete obj.authorId; // Remove from response
      return obj;
    });
    
    res.json(sanitizedConfessions);
  } catch (err) {
    console.error("My Confessions Fetch Error:", err);
    res.status(500).json({ error: "Could not fetch your confessions." });
  }
});

// FIXED: Get Confession Likes
router.get('/confessions/likes/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    if (!confession) return res.status(404).json({ message: "Confession not found" });
    
    const users = await User.find({ _id: { $in: confession.likedBy } })
      .select('name profileImage');
    
    res.json({ likes: users });
  } catch (err) {
    console.error("Get Confession Likes Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// FIXED: Like/Unlike Confession
router.put('/confessions/like/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    const userId = req.user._id;
    const userIdStr = userId.toString();
    
    // Check if user already liked
    const likeIndex = confession.likedBy.findIndex(id => id.toString() === userIdStr);
    let isLiked = false;

    if (likeIndex === -1) {
      confession.likedBy.push(userId);
      confession.likes = (confession.likes || 0) + 1;
      isLiked = true;
    } else {
      confession.likedBy.splice(likeIndex, 1);
      confession.likes = Math.max(0, (confession.likes || 0) - 1);
      isLiked = false;
    }

    await confession.save();
    res.status(200).json({
      likes: confession.likes,
      liked: isLiked
    });
  } catch (err) {
    console.error("Like Confession Error:", err);
    res.status(500).json({ error: "Error updating like" });
  }
});

// FIXED: Add Comment to Confession
router.post('/confessions/comment/:id', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment cannot be empty" });
    }

    const confession = await Confession.findById(req.params.id);
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    const newComment = {
      user: req.user._id,
      text: text.trim(),
      createdAt: new Date()
    };

    confession.comments.push(newComment);
    await confession.save();

    const updatedConfession = await Confession.findById(req.params.id)
      .populate('comments.user', 'name profileImage')
      .lean();

    res.status(200).json(updatedConfession);
  } catch (err) {
    console.error("Comment Confession Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// FIXED: Delete Confession Comment
router.delete('/confessions/comment/:postId/:commentId', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.postId);
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    const commentIndex = confession.comments.findIndex(
      comment => comment._id.toString() === req.params.commentId
    );

    if (commentIndex === -1) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const comment = confession.comments[commentIndex];
    if (!comment.user) {
      return res.status(404).json({ error: "Comment user not found" });
    }

    if (comment.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own comments" });
    }

    confession.comments.splice(commentIndex, 1);
    await confession.save();

    res.status(200).json({ message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Delete Confession Comment Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// FIXED: Get Confessions Feed
router.get('/confessions/feed', auth, async (req, res) => {
  try {
    const confessions = await Confession.find({})
      .sort({ createdAt: -1 })
      .populate('comments.user', 'name profileImage')
      .lean();

    const formattedConfessions = confessions.map(confession => ({
      ...confession,
      authorName: "Anonymous",
      authorAvatar: null,
      likedByCurrentUser: confession.likedBy?.some(id => 
        id && id.toString() === req.user._id.toString()
      ) || false
    }));

    res.status(200).json(formattedConfessions);
  } catch (err) {
    console.error("Confessions Feed Error:", err);
    res.status(500).json({ error: "Could not fetch confessions." });
  }
});

// FIXED: Create Confession
router.post('/confessions/create', auth, async (req, res) => {
  try {
    const { text, image } = req.body;

    if (!text && !image) {
      return res.status(400).json({ error: "Confession cannot be empty." });
    }

    const currentUser = await User.findById(req.user._id).populate('university');
    
    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const confession = new Confession({
      authorId: req.user._id,
      text: text || "",
      image: image || "",
      university: currentUser.university?._id || null,
      location: currentUser.university?.name || "Karachi Campus",
      likes: 0,
      likedBy: [],
      comments: []
    });

    await confession.save();
    
    res.status(201).json({ 
      message: "Confession posted anonymously",
      confession: {
        _id: confession._id,
        text: confession.text,
        image: confession.image,
        university: confession.university,
        location: confession.location,
        likes: confession.likes,
        likedBy: confession.likedBy,
        comments: confession.comments,
        createdAt: confession.createdAt
      }
    });
  } catch (err) {
    console.error("Create Confession Error:", err);
    res.status(500).json({ error: "Failed to post confession." });
  }
});
// ==================== STORIES ROUTES ====================
const canViewStories = async (viewerId, targetId) => {
  if (viewerId === targetId) return true;
  
  const viewer = await User.findById(viewerId).select('connections sentRequests receivedRequests');
  const target = await User.findById(targetId).select('connections sentRequests receivedRequests');
  
  if (!viewer || !target) return false;
  
  const isConnected = viewer.connections.includes(targetId) && target.connections.includes(viewerId);
  if (isConnected) return true;
  
  const hasViewerSentRequest = viewer.sentRequests.includes(targetId);
  if (hasViewerSentRequest) return true;
  
  const hasViewerReceivedRequest = viewer.receivedRequests.includes(targetId);
  if (hasViewerReceivedRequest) return true;
  
  return false;
};

// 1. UPLOAD STORY
router.post('/stories/upload', auth, async (req, res) => {
  try {
    const { image, caption } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const currentUser = await User.findById(req.user._id).select('name profileImage');
    
    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const newStory = new Story({
      author: req.user._id,
      image: image,
      caption: caption || "",
      likes: [],
      comments: [],
      seenBy: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    await newStory.save();
    
    const populatedStory = await Story.findById(newStory._id)
      .populate('author', 'name profileImage');
    
    res.status(201).json({
      success: true,
      story: populatedStory
    });
  } catch (err) {
    console.error("[Upload Story Error]:", err.message);
    res.status(500).json({ error: "Server Error during upload" });
  }
});

// 2. GET ALL STORIES
router.get('/stories', auth, async (req, res) => {
  try {
    const currentUserId = req.user._id;
    
    const activeStories = await Story.find({ 
      expiresAt: { $gt: new Date() } 
    })
    .populate('author', 'name profileImage')
    .sort({ createdAt: -1 });

    const filteredStories = [];
    
    for (const story of activeStories) {
      if (!story.author) continue;
      
      const storyAuthorId = story.author._id.toString();
      const canView = await canViewStories(currentUserId, storyAuthorId);
      
      if (canView) {
        const storyObj = story.toObject();
        storyObj.hasViewed = story.seenBy.some(id => id.toString() === currentUserId.toString());
        storyObj.viewCount = story.seenBy.length;
        filteredStories.push(storyObj);
      }
    }
    
    res.json(filteredStories);
  } catch (err) {
    console.error("[Fetch Stories Error]:", err.message);
    res.status(500).json({ error: "Server Error fetching stories" });
  }
});

// 3. MARK STORY AS SEEN
router.put('/stories/seen/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const currentUserId = req.user._id;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ error: "You cannot view this story" });
    }

    let isNewView = false;
    if (!story.seenBy.includes(currentUserId)) {
      story.seenBy.push(currentUserId);
      isNewView = true;
      await story.save();
    }
    
    const populatedStory = await Story.findById(story._id)
      .populate('seenBy', 'name profileImage')
      .populate('author', 'name profileImage');
    
    res.json({
      success: true,
      seenBy: populatedStory.seenBy,
      viewCount: populatedStory.seenBy.length,
      hasViewed: true,
      isNewView
    });
  } catch (err) {
    console.error("[Seen Story Error]:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// 4. GET STORY VIEWERS
router.get('/stories/views/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id)
      .populate('seenBy', 'name profileImage');
    
    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }
    
    const isAuthor = story.author.toString() === req.user._id.toString();
    
    if (!isAuthor) {
      return res.status(403).json({ error: "Only the story author can view viewers" });
    }
    
    res.json({
      success: true,
      viewCount: story.seenBy.length,
      viewers: story.seenBy,
      isAuthor: true
    });
  } catch (err) {
    console.error("[Viewers Error]:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// 5. LIKE/UNLIKE STORY
router.put('/stories/like/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const currentUserId = req.user._id;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ error: "You cannot interact with this story" });
    }

    const userId = currentUserId.toString();
    const isLiked = story.likes.some(id => id.toString() === userId);
    
    if (isLiked) {
      story.likes = story.likes.filter(id => id.toString() !== userId);
    } else {
      story.likes.push(currentUserId);
    }
    
    await story.save();
    
    const populatedStory = await Story.findById(story._id)
      .populate('likes', 'name profileImage');
    
    res.json({ 
      success: true,
      likes: populatedStory.likes,
      likeCount: populatedStory.likes.length,
      isLiked: !isLiked
    });
  } catch (err) {
    console.error("[Like Story Error]:", err.message);
    res.status(500).json({ error: "Server Error liking story" });
  }
});

// 6. ADD COMMENT TO STORY
router.post('/stories/comment/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment cannot be empty" });
    }

    const currentUserId = req.user._id;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ error: "You cannot interact with this story" });
    }

    const newComment = {
      user: currentUserId,
      text: text.trim(),
      createdAt: new Date()
    };

    story.comments.unshift(newComment);
    await story.save();

    const populatedStory = await Story.findById(story._id)
      .populate('comments.user', 'name profileImage');
    
    res.json({
      success: true,
      comments: populatedStory.comments
    });
  } catch (err) {
    console.error("[Comment Story Error]:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// 7. DELETE STORY
router.delete('/stories/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }
    
    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "You can only delete your own stories" });
    }

    await story.deleteOne();
    res.json({ 
      success: true, 
      message: "Story deleted successfully" 
    });
  } catch (err) {
    console.error("[Delete Story Error]:", err.message);
    res.status(500).json({ error: "Server Error deleting story" });
  }
});

// 8. CHECK STORY VISIBILITY STATUS
router.get('/stories/visibility-status/:targetUserId', auth, async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const targetUserId = req.params.targetUserId;
    
    const currentUser = await User.findById(currentUserId)
      .select('connections sentRequests receivedRequests');
    const targetUser = await User.findById(targetUserId)
      .select('connections sentRequests receivedRequests');
    
    let canViewStories = false;
    let relationshipStatus = 'none';
    let message = '';
    
    if (currentUserId.toString() === targetUserId) {
      canViewStories = true;
      relationshipStatus = 'self';
      message = 'This is your own profile';
    }
    else if (currentUser.connections.includes(targetUserId) && targetUser.connections.includes(currentUserId)) {
      canViewStories = true;
      relationshipStatus = 'connected';
      message = 'You are connected';
    }
    else if (currentUser.sentRequests.includes(targetUserId)) {
      canViewStories = true;
      relationshipStatus = 'pending_sent';
      message = 'Request sent - you can view their stories';
    }
    else if (currentUser.receivedRequests.includes(targetUserId)) {
      canViewStories = true;
      relationshipStatus = 'pending_received';
      message = 'Request received - you can view their stories';
    }
    else {
      canViewStories = false;
      relationshipStatus = 'none';
      message = 'Send a connection request to view their stories';
    }
    
    res.json({ 
      canViewStories, 
      relationshipStatus, 
      message 
    });
  } catch (err) {
    console.error("[Visibility Check Error]:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// -------------------- USER & CONNECTIONS --------------------
// -------------------- USER SEARCH (STUDENTS ONLY) - FIXED NULL SAFETY --------------------
router.get('/users/search', async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.json({ users: [], hasMore: false, total: 0 });
    }

    const searchRegex = new RegExp(q.trim(), 'i');
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Build query - only students
    const query = {
      $or: [
        { name: searchRegex },
        { headline: searchRegex },
        { 'university.name': searchRegex }
      ],
      role: 'student'
    };

    // If authenticated, exclude current user and blocked users
    if (req.user && req.user._id) {
      query._id = { $ne: req.user._id };
      
      // Get blocked users
      try {
        const blockedUsers = await BlockedUser.find({ userId: req.user._id })
          .select('blockedUserId');
        const blockedUserIds = blockedUsers
          .map(b => b.blockedUserId ? b.blockedUserId.toString() : null)
          .filter(id => id !== null);
        
        if (blockedUserIds.length > 0) {
          query._id = { $ne: req.user._id, $nin: blockedUserIds };
        }
      } catch (err) {
        console.error("Error fetching blocked users:", err);
        // Continue without blocking
      }
    }

    // Get total count for pagination
    const total = await User.countDocuments(query);
    
    // Fetch users with null-safe operations
    const users = await User.find(query)
      .select('name profileImage headline university followers role connections')
      .populate('university', 'name')
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get current user's connections for mutual friends (if authenticated)
    let currentConnections = [];
    if (req.user && req.user._id) {
      try {
        const currentUser = await User.findById(req.user._id).select('connections');
        if (currentUser && currentUser.connections) {
          currentConnections = currentUser.connections
            .filter(id => id !== null && id !== undefined)
            .map(id => id.toString());
        }
      } catch (err) {
        console.error("Error fetching current user connections:", err);
      }
    }
    
    // Process users with null safety
    const usersWithMutual = users.map(user => {
      // SAFE: Get user connections with null checks
      let userConnections = [];
      try {
        if (user.connections && Array.isArray(user.connections)) {
          userConnections = user.connections
            .filter(id => id !== null && id !== undefined)
            .map(id => id.toString());
        }
      } catch (err) {
        // If connections fails, use empty array
        userConnections = [];
      }
      
      // Calculate mutual friends safely
      let mutualFriends = 0;
      try {
        if (currentConnections.length > 0 && userConnections.length > 0) {
          mutualFriends = userConnections.filter(id => 
            currentConnections.includes(id)
          ).length;
        }
      } catch (err) {
        mutualFriends = 0;
      }
      
      // SAFE: Remove connections from response
      const { connections, ...userWithoutConnections } = user;
      
      return {
        ...userWithoutConnections,
        mutualFriends: mutualFriends || 0,
        role: user.role || 'student',
        followers: user.followers || 0,
        profileImage: user.profileImage || '',
        headline: user.headline || '',
        university: user.university || null
      };
    });

    const hasMore = total > skip + users.length;

    res.json({
      users: usersWithMutual,
      hasMore: hasMore,
      total: total,
      page: parseInt(page),
      limit: parseInt(limit)
    });

  } catch (err) {
    console.error("[Search Error]:", err.message);
    console.error("[Search Stack]:", err.stack);
    res.status(500).json({ 
      error: "Search failed", 
      details: err.message 
    });
  }
});

// ==================== CONNECTION ROUTES ====================

// 1. Send Connection Request
router.post('/user/connect/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    const userId = req.user._id;

    if (targetId === userId.toString()) {
      return res.status(400).json({ error: "Cannot connect with yourself" });
    }

    const targetUser = await User.findById(targetId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const currentUser = await User.findById(userId);

    if (currentUser.connections.includes(targetId)) {
      return res.status(400).json({ error: "Already connected" });
    }

    if (currentUser.sentRequests.includes(targetId)) {
      return res.status(400).json({ error: "Request already sent" });
    }

    if (currentUser.receivedRequests.includes(targetId)) {
      return res.status(400).json({ error: "This user already sent you a request" });
    }

    await User.findByIdAndUpdate(userId, {
      $addToSet: { sentRequests: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $addToSet: { receivedRequests: userId }
    });

    await createNotification(
      targetId,
      userId,
      'request',
      `${currentUser.name} wants to connect with you.`,
      null
    );

    const updatedUser = await User.findById(userId)
      .select('-password -email')
      .populate('university', 'name');

    res.json({ 
      success: true, 
      status: "pending",
      message: "Connection request sent successfully",
      user: updatedUser
    });

  } catch (err) {
    console.error("Connect Error:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

// 2. Respond to Connection Request
router.post('/notifications/respond', auth, async (req, res) => {
  try {
    const { notificationId, action } = req.body;
    
    if (!notificationId || !action) {
      return res.status(400).json({ error: "Notification ID and action are required" });
    }

    if (!['accepted', 'declined'].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Use 'accepted' or 'declined'" });
    }

    const notification = await Notification.findById(notificationId)
      .populate('sender', 'name profileImage username')
      .populate('recipient', 'name profileImage username');

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    if (notification.recipient._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (notification.isProcessed) {
      return res.status(400).json({ 
        error: "This request has already been processed",
        status: notification.status
      });
    }

    if (notification.type !== 'request') {
      return res.status(400).json({ error: "This notification is not a connection request" });
    }

    const senderId = notification.sender._id;
    const recipientId = notification.recipient._id;

    if (action === 'accepted') {
      const recipient = await User.findById(recipientId);
      if (recipient.connections.includes(senderId)) {
        notification.isProcessed = true;
        notification.status = 'accepted';
        await notification.save();
        return res.json({ 
          success: true, 
          message: "Already connected",
          status: 'accepted'
        });
      }

      await User.findByIdAndUpdate(recipientId, {
        $addToSet: { connections: senderId },
        $pull: { receivedRequests: senderId }
      });

      await User.findByIdAndUpdate(senderId, {
        $addToSet: { connections: recipientId },
        $pull: { sentRequests: recipientId }
      });

      notification.status = 'accepted';
      notification.isProcessed = true;
      notification.text = `${notification.recipient.name} accepted your connection request.`;
      notification.type = 'connection_accepted';
      await notification.save();

      await createNotification(
        senderId,
        recipientId,
        'connection_accepted',
        `${notification.recipient.name} accepted your connection request 🎉`,
        null
      );

      const updatedRecipient = await User.findById(recipientId)
        .select('-password -email')
        .populate('university', 'name');
      const updatedSender = await User.findById(senderId)
        .select('-password -email')
        .populate('university', 'name');

      res.json({ 
        success: true, 
        message: "Connection accepted successfully!",
        status: 'accepted',
        notification: notification,
        recipient: updatedRecipient,
        sender: updatedSender
      });

    } else if (action === 'declined') {
      await User.findByIdAndUpdate(recipientId, {
        $pull: { receivedRequests: senderId }
      });

      await User.findByIdAndUpdate(senderId, {
        $pull: { sentRequests: recipientId }
      });

      notification.status = 'declined';
      notification.isProcessed = true;
      notification.text = `${notification.recipient.name} declined your connection request.`;
      notification.type = 'request_declined';
      await notification.save();

      await createNotification(
        senderId,
        recipientId,
        'request_declined',
        `${notification.recipient.name} declined your connection request.`,
        null
      );

      res.json({ 
        success: true, 
        message: "Request declined.",
        status: 'declined',
        notification: notification
      });
    }

  } catch (err) {
    console.error("Response Error:", err.message);
    res.status(500).json({ error: "Response failed" });
  }
});

// 3. Cancel Sent Request
router.post('/user/cancel-request/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    const userId = req.user._id;

    await User.findByIdAndUpdate(userId, {
      $pull: { sentRequests: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $pull: { receivedRequests: userId }
    });

    await Notification.findOneAndDelete({
      recipient: targetId,
      sender: userId,
      type: 'request',
      status: 'pending',
      isProcessed: false
    });

    const updatedUser = await User.findById(userId)
      .select('-password -email')
      .populate('university', 'name');

    res.json({ 
      success: true, 
      message: "Request cancelled successfully",
      user: updatedUser
    });

  } catch (err) {
    console.error("Cancel Request Error:", err);
    res.status(500).json({ error: "Failed to cancel request" });
  }
});

// 4. Disconnect User
router.post('/user/disconnect/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    const userId = req.user._id;

    await User.findByIdAndUpdate(userId, {
      $pull: { connections: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $pull: { connections: userId }
    });

    await User.findByIdAndUpdate(userId, {
      $pull: { sentRequests: targetId, receivedRequests: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $pull: { sentRequests: userId, receivedRequests: userId }
    });

    await Notification.deleteMany({
      $or: [
        { recipient: userId, sender: targetId, type: 'request', isProcessed: false },
        { recipient: targetId, sender: userId, type: 'request', isProcessed: false }
      ]
    });

    const updatedUser = await User.findById(userId)
      .select('-password -email')
      .populate('university', 'name');

    res.json({ 
      success: true, 
      status: "disconnected",
      message: "Disconnected successfully",
      user: updatedUser
    });

  } catch (err) {
    console.error("Disconnect Error:", err);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// 5. Get Notifications
router.get('/notifications', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ 
      recipient: req.user._id 
    })
    .populate('sender', 'name profileImage username')
    .populate('postId', 'content image')
    .sort({ createdAt: -1 });

    const transformedNotifications = notifications.map(notification => {
      const notif = notification.toObject();
      
      const hasRead = notif.readBy?.some(id => id.toString() === req.user._id.toString());
      notif.isUnread = !hasRead;
      
      if (notif.type === 'request') {
        notif.status = notif.status || 'pending';
        notif.isProcessed = notif.isProcessed || false;
      }
      
      if (notif.type === 'connection_accepted' || notif.type === 'request_declined') {
        notif.isProcessed = true;
        notif.status = notif.type === 'connection_accepted' ? 'accepted' : 'declined';
      }
      
      return notif;
    });

    res.json(transformedNotifications);

  } catch (err) {
    console.error("Fetch Notifications Error:", err.message);
    res.status(500).json({ message: "Server Error" });
  }
});

// 6. Get User's Connections
router.get('/user/connections/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .populate({
        path: 'connections',
        select: 'name profileImage username headline online'
      });
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    
    res.json({ 
      connections: user.connections || [],
      count: user.connections?.length || 0
    });

  } catch (err) {
    console.error("Fetch connections error:", err);
    res.status(500).json({ error: "Failed to fetch connections" });
  }
});

// 7. Mark Notification as Read
router.put('/notifications/read/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    if (notification.recipient.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!notification.readBy.includes(req.user._id)) {
      notification.readBy.push(req.user._id);
      await notification.save();
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Error updating" });
  }
});

// 8. Mark All Notifications as Read
router.put('/notifications/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { 
        recipient: req.user._id, 
        readBy: { $ne: req.user._id } 
      },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json({ success: true });

  } catch (err) {
    console.error("Mark all read error:", err);
    res.status(500).json({ error: "Error updating all" });
  }
});

// 9. Clear All Notifications
router.delete('/notifications/clear-all', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    
    const notifications = await Notification.find({ 
      recipient: userId 
    });
    
    const pendingRequests = notifications.filter(
      n => n.type === 'request' && n.status === 'pending' && !n.isProcessed
    );
    
    const result = await Notification.deleteMany({ 
      recipient: userId,
      _id: { $nin: pendingRequests.map(n => n._id) }
    });
    
    res.json({ 
      success: true, 
      message: `${result.deletedCount} notifications cleared successfully`,
      deletedCount: result.deletedCount,
      pendingRequestsCount: pendingRequests.length
    });
  } catch (err) {
    console.error("Clear all error:", err);
    res.status(500).json({ error: "Error clearing notifications" });
  }
});

// 10. Get Unread Notification Count
router.get('/notifications/unread-count', auth, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      readBy: { $ne: req.user._id }
    });
    res.json({ unreadCount: count });

  } catch (err) {
    console.error("Unread count error:", err);
    res.status(500).json({ error: "Error fetching unread count" });
  }
});

// -------------------- MESSAGING --------------------
router.get('/inbox', auth, async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id,
      isArchived: { $ne: true }
    })
    .populate({
      path: "participants",
      select: "name profileImage headline bio location online"
    })
    .sort({ updatedAt: -1 });

    const enrichedConversations = await Promise.all(conversations.map(async (conv) => {
      const convObj = conv.toObject();
      
      const unreadCount = await Message.countDocuments({
        conversationId: conv._id,
        sender: { $ne: req.user.id },
        isRead: false
      });
      
      convObj.unreadCount = unreadCount;
      
      const lastMsg = await Message.findOne({ conversationId: conv._id })
        .sort({ createdAt: -1 })
        .populate('sender', 'name');
      
      if (lastMsg) {
        convObj.lastMessage = lastMsg.text || 'Media message';
        convObj.lastMessageType = lastMsg.messageType;
        convObj.lastMessageSender = lastMsg.sender;
        convObj.lastMessageTime = lastMsg.createdAt;
      }
      
      return convObj;
    }));

    res.json(enrichedConversations);
  } catch (err) {
    console.error("Inbox Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== MESSAGES ====================
router.get('/messages/:conversationId', auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, before } = req.query;
    
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.user.id
    });
    
    if (!conversation) {
      return res.status(403).json({ error: "Not authorized to view these messages" });
    }
    
    let query = { conversationId };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }
    
    const messages = await Message.find(query)
      .populate('sender', 'name profileImage')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    await Message.updateMany(
      {
        conversationId,
        sender: { $ne: req.user.id },
        isRead: false
      },
      {
        $set: { isRead: true, readAt: new Date() }
      }
    );
    
    await Conversation.findByIdAndUpdate(conversationId, {
      unreadCount: 0
    });
    
    res.json(messages.reverse());
  } catch (err) {
    console.error("Messages Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== GET OR CREATE CONVERSATION ====================
router.post('/conversations/get-or-create', auth, async (req, res) => {
  try {
    const { recipientId } = req.body;
    const senderId = req.user.id;

    if (!recipientId) {
      return res.status(400).json({ error: "Recipient ID is required" });
    }

    if (recipientId === senderId) {
      return res.status(400).json({ error: "Cannot create conversation with yourself" });
    }

    let conversation = await Conversation.findOne({
      participants: { $all: [senderId, recipientId] }
    });

    if (!conversation) {
      conversation = new Conversation({
        participants: [senderId, recipientId],
        lastMessage: "Start a conversation..."
      });
      await conversation.save();
    }

    const populated = await Conversation.findById(conversation._id)
      .populate('participants', 'name profileImage online');

    res.json({ 
      conversationId: populated._id,
      conversation: populated
    });
  } catch (err) {
    console.error("Get or Create Conversation Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== DELETE CONVERSATION ====================
router.delete('/conversations/:id', auth, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user.id;

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId
    });

    if (!conversation) {
      return res.status(404).json({ 
        success: false, 
        error: "Conversation not found or you are not a participant" 
      });
    }

    await Message.deleteMany({ conversationId: conversation._id });
    await Conversation.findByIdAndDelete(conversation._id);

    const io = req.app.get('io');
    if (io) {
      io.emit('conversation_deleted', { conversationId: conversation._id });
      io.emit('inbox_update');
    }

    res.json({ 
      success: true, 
      message: "Conversation deleted successfully",
      conversationId: conversation._id
    });
  } catch (err) {
    console.error("Delete Conversation Error:", err);
    res.status(500).json({ 
      success: false, 
      error: "Server Error" 
    });
  }
});

// ==================== DELETE SINGLE MESSAGE ====================
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    const messageId = req.params.id;
    const userId = req.user.id;

    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ 
        success: false, 
        error: "Message not found" 
      });
    }

    if (message.sender.toString() !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: "You can only delete your own messages" 
      });
    }

    await Message.findByIdAndDelete(messageId);

    const io = req.app.get('io');
    if (io) {
      io.to(message.conversationId).emit('message_deleted', { 
        messageId: messageId,
        conversationId: message.conversationId 
      });
      io.emit('inbox_update');
    }

    res.json({ 
      success: true, 
      message: "Message deleted successfully" 
    });
  } catch (err) {
    console.error("Delete Message Error:", err);
    res.status(500).json({ 
      success: false, 
      error: "Server Error" 
    });
  }
});

// ==================== MUTE CONVERSATION ====================
router.post('/conversations/:id/mute', auth, async (req, res) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      participants: req.user.id
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    conversation.isMuted = !conversation.isMuted;
    await conversation.save();

    res.json({ 
      success: true, 
      isMuted: conversation.isMuted,
      message: conversation.isMuted ? "Conversation muted" : "Conversation unmuted"
    });
  } catch (err) {
    console.error("Mute Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== ARCHIVE CONVERSATION ====================
router.post('/conversations/:id/archive', auth, async (req, res) => {
  try {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      participants: req.user.id
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    conversation.isArchived = !conversation.isArchived;
    await conversation.save();

    res.json({ 
      success: true, 
      isArchived: conversation.isArchived,
      message: conversation.isArchived ? "Conversation archived" : "Conversation unarchived"
    });
  } catch (err) {
    console.error("Archive Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== GET UNREAD COUNT ====================
router.get('/unread-count', auth, async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id
    });

    let totalUnread = 0;
    for (const conv of conversations) {
      const count = await Message.countDocuments({
        conversationId: conv._id,
        sender: { $ne: req.user.id },
        isRead: false
      });
      totalUnread += count;
    }

    res.json({ unreadCount: totalUnread });
  } catch (err) {
    console.error("Unread Count Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

// ==================== MARK MESSAGES AS READ ====================
router.post('/messages/mark-read/:conversationId', auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;
    
    const io = req.app.get('io');
    
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId
    });
    
    if (!conversation) {
      return res.status(403).json({ error: "Not authorized" });
    }
    
    const result = await Message.updateMany(
      {
        conversationId: conversationId,
        sender: { $ne: userId },
        isRead: false
      },
      {
        $set: { isRead: true, readAt: new Date() }
      }
    );
    
    await Conversation.findByIdAndUpdate(conversationId, {
      unreadCount: 0
    });
    
    if (io) {
      io.to(conversationId).emit('messages_read', { 
        conversationId, 
        userId 
      });
      io.emit('inbox_update');
    }
    
    res.json({ 
      success: true, 
      message: "Messages marked as read",
      modifiedCount: result.modifiedCount 
    });
  } catch (err) {
    console.error("Mark Read Error:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
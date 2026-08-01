// socialRoutes.js - Complete Fixed Version

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Post = require('../models/Post');
const Confession = require('../models/Confession');
const User = require('../models/User');
const Story = require('../models/Story');
const Notification = require('../models/SocialNotification');
const createNotification = require('../utils/notificationHelper');
const { Conversation, Message } = require('../models/Chat');

// -------------------- FEED & POSTS --------------------
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

// --- Feed Route - COMPLETELY FIXED with null author handling ---
router.get('/feed', auth, async (req, res) => {
  try {
    const { category, search, limit = 20, before } = req.query;
    const userId = req.user._id;
    
    let query = {};

    if (category && category !== "All") {
      query.category = category;
    }

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search, 'i');
      const matchingUsers = await User.find({ name: searchRegex }).select('_id');
      const userIds = matchingUsers.map(user => user._id);

      query.$or = [
        { content: searchRegex },
        { author: { $in: userIds } }
      ];
    }

    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    // Get current user's connections and sent requests with null checks
    const currentUser = await User.findById(userId).select('connections sentRequests receivedRequests');
    
    // Safely map with fallback empty arrays
    const userConnections = (currentUser?.connections || []).map(id => id ? id.toString() : '');
    const userSentRequests = (currentUser?.sentRequests || []).map(id => id ? id.toString() : '');
    const userReceivedRequests = (currentUser?.receivedRequests || []).map(id => id ? id.toString() : '');

    // Get posts and populate author
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

    // STEP 1: Filter out posts with null or undefined author FIRST
    const validPosts = posts.filter(post => {
      return post && post.author !== null && post.author !== undefined;
    });

    // STEP 2: Map through only valid posts
    const postsWithStatus = validPosts.map(post => {
      const postObj = post.toObject();
      const author = post.author;
      
      // Safety check - should never be null here but just in case
      if (!author) {
        return null;
      }
      
      // SAFE: Get author ID with proper null checks
      let authorId = '';
      try {
        authorId = author._id ? author._id.toString() : '';
      } catch (err) {
        authorId = '';
      }
      
      const userIdStr = userId.toString();
      
      // Determine connection status with safe checks
      let connectionStatus = 'none';
      if (authorId === userIdStr) {
        connectionStatus = 'self';
      } else if (userConnections.includes(authorId)) {
        connectionStatus = 'connected';
      } else if (userSentRequests.includes(authorId)) {
        connectionStatus = 'pending';
      } else if (author.receivedRequests && Array.isArray(author.receivedRequests)) {
        // Safe check for received requests
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
      
      // Build author object safely
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
      
      // Safe check for viewedBy
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
      
      return postObj;
    })
    .filter(post => post !== null); // Remove any null entries

    // Calculate hasMore based on original posts length
    const hasMore = posts.length === parseInt(limit);

    res.json({
      posts: postsWithStatus,
      hasMore: hasMore
    });
    
  } catch (err) {
    console.error("[Backend Error] Feed/Search:", err.message);
    console.error("[Backend Error] Stack:", err.stack);
    res.status(500).json({ 
      error: "Failed to fetch feed results.",
      details: err.message 
    });
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

// social.routes.js - FIXED Get Single Post route

// --- Get Single Post ---
router.get('/posts/:id', auth, async (req, res) => {
  try {
    // ========== FIXED: Validate and clean post ID ==========
    let postId = req.params.id;
    
    // If the ID is an object, extract the _id
    if (postId && typeof postId === 'object') {
      postId = postId._id || postId.toString();
    }
    
    // Validate ObjectId format
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
// --- Get User Profile with connection status ---
router.get('/profile/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const currentUserId = req.user._id;
    
    // Get current user's connections and sent requests
    const currentUser = await User.findById(currentUserId).select('connections sentRequests receivedRequests');
    
    // SAFE: Map with fallback empty arrays and null checks
    const userConnections = (currentUser?.connections || []).map(id => id ? id.toString() : '');
    const userSentRequests = (currentUser?.sentRequests || []).map(id => id ? id.toString() : '');
    const userReceivedRequests = (currentUser?.receivedRequests || []).map(id => id ? id.toString() : '');
    
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
    
    // Determine connection status with safe checks
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
    
    // Get connection count safely
    const connectionCount = profile.connections?.length || 0;
    
    const posts = await Post.find({ author: userId })
      .populate({
        path: 'author',
        select: 'name profileImage university connections sentRequests receivedRequests',
        populate: { path: 'university', select: 'name' }
      })
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage')
      .sort({ createdAt: -1 });

    // SAFE: Filter out posts with null/undefined author
    const validPosts = posts.filter(post => post && post.author !== null && post.author !== undefined);

    // SAFE: Map through valid posts with connection status
    const postsWithStatus = validPosts.map(post => {
      const postObj = post.toObject();
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
      
      const userIdStr = currentUserId.toString();
      
      // Determine connection status for post author
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
      
      // Build author object safely
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
      
      return postObj;
    }).filter(post => post !== null);

    // Convert to plain object and add connection status
    const profileObj = profile.toObject();
    profileObj.connectionStatus = connectionStatus;
    profileObj.isConnected = connectionStatus === 'connected';
    profileObj.isPending = connectionStatus === 'pending';
    profileObj.isReceived = connectionStatus === 'received';
    profileObj.connectionCount = connectionCount;

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

// ==================== CONFESSION ROUTES ====================
router.get('/confessions/feed', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id)
      .populate('connections', '_id');
    
    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const connectedUserIds = currentUser.connections.map(conn => conn._id);
    const currentUniversityId = currentUser.university;
    
    const confessions = await Confession.find({
      $or: [
        { university: currentUniversityId },
        { authorId: { $in: connectedUserIds } }
      ]
    })
    .select('-authorId')
    .sort({ createdAt: -1 })
    .populate('comments.user', 'name profileImage')
    .lean();

    const formattedConfessions = confessions.map(confession => ({
      ...confession,
      authorName: "Anonymous",
      authorAvatar: null,
      likedByCurrentUser: confession.likedBy?.includes(req.user._id) || false
    }));

    res.status(200).json(formattedConfessions);
  } catch (err) {
    console.error("Feed Error:", err);
    res.status(500).json({ error: "Could not fetch feed." });
  }
});

// --- Create Confession ---
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
    
    const createdConfession = await Confession.findById(confession._id)
      .select('-authorId')
      .lean();
    
    res.status(201).json({ 
      message: "Confession posted anonymously",
      confession: createdConfession
    });
  } catch (err) {
    console.error("Create Error:", err);
    res.status(500).json({ error: "Failed to post confession." });
  }
});

// --- Like/Unlike Confession ---
router.put('/confessions/like/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    const likeIndex = confession.likedBy.indexOf(req.user._id);
    let isLiked = false;

    if (likeIndex === -1) {
      confession.likedBy.push(req.user._id);
      confession.likes += 1;
      isLiked = true;
    } else {
      confession.likedBy.splice(likeIndex, 1);
      confession.likes -= 1;
      isLiked = false;
    }

    await confession.save();
    res.status(200).json({
      likes: confession.likes,
      liked: isLiked
    });
  } catch (err) {
    console.error("Like Error:", err);
    res.status(500).json({ error: "Error updating like" });
  }
});

// --- Add Comment to Confession ---
router.post('/confessions/comment/:id', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Comment cannot be empty" });
    }

    const confession = await Confession.findById(req.params.id);
    if (!confession) {
      return res.status(404).json({ error: "Post not found" });
    }

    const newComment = {
      user: req.user._id,
      text: text.trim(),
      createdAt: new Date()
    };

    confession.comments.push(newComment);
    await confession.save();

    const updatedConfession = await Confession.findById(req.params.id)
      .select('-authorId')
      .populate('comments.user', 'name profileImage')
      .lean();

    res.status(200).json(updatedConfession);
  } catch (err) {
    console.error("Comment Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Delete Confession Comment ---
router.delete('/confessions/comment/:postId/:commentId', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.postId);
    if (!confession) {
      return res.status(404).json({ error: "Post not found" });
    }

    const commentIndex = confession.comments.findIndex(
      comment => comment._id.toString() === req.params.commentId
    );

    if (commentIndex === -1) {
      return res.status(404).json({ error: "Comment not found" });
    }

    if (confession.comments[commentIndex].user.toString() !== req.user._id) {
      return res.status(403).json({ error: "You can only delete your own comments" });
    }

    confession.comments.splice(commentIndex, 1);
    await confession.save();

    res.status(200).json({ message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Delete Comment Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Delete Confession ---
router.delete('/confessions/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    
    if (!confession) {
      return res.status(404).json({ error: "Confession not found" });
    }

    if (confession.authorId.toString() !== req.user._id) {
      return res.status(403).json({ error: "You can only delete your own confessions" });
    }

    await confession.deleteOne();
    res.status(200).json({ message: "Confession deleted successfully" });
  } catch (err) {
    console.error("Delete Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== STORIES ROUTES ====================
// Helper function to check if users can see each other's stories
const canViewStories = async (viewerId, targetId) => {
  if (viewerId === targetId) return true;
  
  const viewer = await User.findById(viewerId).select('connections sentRequests receivedRequests');
  const target = await User.findById(targetId).select('connections sentRequests receivedRequests');
  
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
router.get('/users/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const users = await User.find({
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { headline: { $regex: q, $options: 'i' } }
      ]
    })
    .select('name profileImage headline university')
    .populate('university', 'name')
    .limit(10);

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// ==================== CONNECTION ROUTES ====================

// 1. Send Connection Request - FIXED with better response
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

    // Check if already connected
    if (currentUser.connections.includes(targetId)) {
      return res.status(400).json({ error: "Already connected" });
    }

    // Check if request already sent
    if (currentUser.sentRequests.includes(targetId)) {
      return res.status(400).json({ error: "Request already sent" });
    }

    // Check if request already received from target
    if (currentUser.receivedRequests.includes(targetId)) {
      return res.status(400).json({ error: "This user already sent you a request" });
    }

    // Add to sent requests
    await User.findByIdAndUpdate(userId, {
      $addToSet: { sentRequests: targetId }
    });

    // Add to target's received requests
    await User.findByIdAndUpdate(targetId, {
      $addToSet: { receivedRequests: userId }
    });

    // Create notification for target user
    await createNotification(
      targetId,
      userId,
      'request',
      `${currentUser.name} wants to connect with you.`,
      null
    );

    // Get updated user to return
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

// 2. Respond to Connection Request (Accept/Decline) - FIXED
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

      // Add connections to both users
      await User.findByIdAndUpdate(recipientId, {
        $addToSet: { connections: senderId },
        $pull: { receivedRequests: senderId }
      });

      await User.findByIdAndUpdate(senderId, {
        $addToSet: { connections: recipientId },
        $pull: { sentRequests: recipientId }
      });

      // Update notification
      notification.status = 'accepted';
      notification.isProcessed = true;
      notification.text = `${notification.recipient.name} accepted your connection request.`;
      notification.type = 'connection_accepted';
      await notification.save();

      // Send acceptance notification to sender
      await createNotification(
        senderId,
        recipientId,
        'connection_accepted',
        `${notification.recipient.name} accepted your connection request 🎉`,
        null
      );

      // Get updated users
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
      // Remove from received requests
      await User.findByIdAndUpdate(recipientId, {
        $pull: { receivedRequests: senderId }
      });

      // Remove from sender's sent requests
      await User.findByIdAndUpdate(senderId, {
        $pull: { sentRequests: recipientId }
      });

      // Update notification
      notification.status = 'declined';
      notification.isProcessed = true;
      notification.text = `${notification.recipient.name} declined your connection request.`;
      notification.type = 'request_declined';
      await notification.save();

      // Send decline notification to sender
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

    // Remove from sent requests
    await User.findByIdAndUpdate(userId, {
      $pull: { sentRequests: targetId }
    });

    // Remove from target's received requests
    await User.findByIdAndUpdate(targetId, {
      $pull: { receivedRequests: userId }
    });

    // Delete pending notification
    await Notification.findOneAndDelete({
      recipient: targetId,
      sender: userId,
      type: 'request',
      status: 'pending',
      isProcessed: false
    });

    // Get updated user
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

    // Remove from each other's connections
    await User.findByIdAndUpdate(userId, {
      $pull: { connections: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $pull: { connections: userId }
    });

    // Clean up any pending requests
    await User.findByIdAndUpdate(userId, {
      $pull: { sentRequests: targetId, receivedRequests: targetId }
    });

    await User.findByIdAndUpdate(targetId, {
      $pull: { sentRequests: userId, receivedRequests: userId }
    });

    // Delete any pending notifications
    await Notification.deleteMany({
      $or: [
        { recipient: userId, sender: targetId, type: 'request', isProcessed: false },
        { recipient: targetId, sender: userId, type: 'request', isProcessed: false }
      ]
    });

    // Get updated user
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

// 5. Get Notifications (with proper filters)
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

// 6. Get User Profile (with connection status) - FIXED
router.get('/profile/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    const currentUserId = req.user._id;
    
    // Get current user's connections and sent requests
    const currentUser = await User.findById(currentUserId).select('connections sentRequests receivedRequests');
    const userConnections = currentUser.connections.map(id => id.toString());
    const userSentRequests = currentUser.sentRequests.map(id => id.toString());
    const userReceivedRequests = currentUser.receivedRequests.map(id => id.toString());
    
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

    // Get posts
    const posts = await Post.find({ author: userId })
      .populate({
        path: 'author',
        select: 'name profileImage university'
      })
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage')
      .sort({ createdAt: -1 });

    // Determine connection status
    let connectionStatus = 'none';
    if (userId.toString() === currentUserId.toString()) {
      connectionStatus = 'self';
    } else if (userConnections.includes(userId.toString())) {
      connectionStatus = 'connected';
    } else if (userSentRequests.includes(userId.toString())) {
      connectionStatus = 'pending';
    } else if (userReceivedRequests.includes(userId.toString())) {
      connectionStatus = 'received';
    }

    const profileObj = profile.toObject();
    profileObj.connectionStatus = connectionStatus;
    profileObj.isConnected = connectionStatus === 'connected';
    profileObj.isPending = connectionStatus === 'pending';
    profileObj.isReceived = connectionStatus === 'received';

    res.json({ 
      profile: profileObj, 
      posts,
      connections: profile.connections || [],
      connectionStatus
    });

  } catch (err) {
    console.error("Profile Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch profile content" });
  }
});

// 7. Get User's Connections
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

// 8. Mark Notification as Read
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

// 9. Mark All Notifications as Read
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

// 10. Clear All Notifications - FIXED
router.delete('/notifications/clear-all', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Get all notifications for the user
    const notifications = await Notification.find({ 
      recipient: userId 
    });
    
    // Separate pending requests from other notifications
    const pendingRequests = notifications.filter(
      n => n.type === 'request' && n.status === 'pending' && !n.isProcessed
    );
    
    // Delete all notifications EXCEPT pending connection requests
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

// 11. Get Unread Notification Count
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
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const Post =require('../models/Post');
const Confession =require('../models/Confession');
const User =require('../models/User');
const Story =require('../models/Story');
const Notification =require('../models/SocialNotification');
const  createNotification  = require('../utils/notificationHelper');
const { Conversation, Message } = require('../models/Chat');



// -------------------- FEED & POSTS --------------------
router.post('/create-post', auth, async (req, res) => {
  try {
    const { content, category, image, poll, location } = req.body;

    if (!content && !image) {
      return res.status(400).json({ error: "Please add some text or an image to your post." });
    }

    // Now 'Post' is the constructor, so 'new Post()' will work!
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
        select: 'name profileImage university',
        populate: { path: 'university', select: 'name' }
      });

    res.status(201).json(populatedPost);
  } catch (err) {
    console.error("[Backend Error] Create Post:", err.message);
    res.status(500).json({ error: "Database error: Could not save your post." });
  }
});

// --- 1. Fetch Feed (Fixed Population) ---
// routes/social.js - UPDATED Feed Route
router.get('/feed', auth, async (req, res) => {
  try {
    const { category, search, limit = 20, before } = req.query;
    const userId = req.user._id;
    
    let query = {};

    // ✅ FIX: Don't exclude user's own posts OR viewed posts
    // Instead, just fetch posts and track views separately
    
    // 1. Handle Category Filter
    if (category && category !== "All") {
      query.category = category;
    }

    // 2. Handle Search Query
    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search, 'i');
      const matchingUsers = await User.find({ name: searchRegex }).select('_id');
      const userIds = matchingUsers.map(user => user._id);

      query.$or = [
        { content: searchRegex },
        { author: { $in: userIds } }
      ];
    }

    // 3. Pagination - get posts older than 'before' timestamp
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const posts = await Post.find(query)
      .populate({
        path: 'author',
        select: 'name profileImage university',
        populate: { path: 'university', select: 'name' }
      })
      .populate({
        path: 'comments.user',
        select: 'name profileImage'
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    // ✅ Add a flag to indicate if current user has viewed each post
    const postsWithViewStatus = posts.map(post => {
      const postObj = post.toObject();
      postObj.hasViewed = post.viewedBy?.includes(userId) || false;
      return postObj;
    });

    res.json({
      posts: postsWithViewStatus,
      hasMore: posts.length === parseInt(limit)
    });
  } catch (err) {
    console.error("[Backend Error] Feed/Search:", err.message);
    res.status(500).json({ error: "Failed to fetch feed results." });
  }
});

// routes/social.js - Add this new route
router.post('/posts/view/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const userId = req.user._id;
    
    // Only add if not already in viewedBy array
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

// --- 2. Toggle Like ---
// Toggle Like on Post
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
      
      // Create notification with postId
      if (post.author.toString() !== userId.toString()) {
        await createNotification(
          post.author,      // recipient
          req.user._id,     // sender
          'like',           // type
          `${req.user.name} liked your post`, // text
          post._id          // postId - THIS IS CRITICAL
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

// Get Post Likes
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

// --- 3. Add Comment ---
// Add Comment
router.post('/posts/comment/:id', auth, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Comment text cannot be empty." });
    }

    // Find post and add comment
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found." });

    const newComment = {
      user: req.user._id,
      text: text.trim(),
      createdAt: new Date()
    };

    post.comments.unshift(newComment);
    await post.save();

    // CRITICAL: Re-fetch the post and populate user details for ALL comments
    const updatedPost = await Post.findById(req.params.id)
      .populate('comments.user', 'name profileImage');

    // Create Notification with postId
    const previewText = text.length > 20 ? text.substring(0, 20) + "..." : text;
    if (post.author.toString() !== req.user._id.toString()) {
       await createNotification(
         post.author,       // recipient
         req.user._id,      // sender
         'comment',         // type
         `${req.user.name} commented: "${previewText}"`, // text
         post._id           // postId - THIS IS CRITICAL
       );
    }

    // Return the FULL updated comments array
    res.json({ success: true, comments: updatedPost.comments });
  } catch (err) { 
    console.error("Comment Logic Error:", err.message);
    res.status(500).json({ error: "Internal Server Error" }); 
  }
});

// --- 4. Favorite ---
router.post('/posts/favorite/:id', auth, async (req, res) => {
  try {

    const post = await Post.findById(req.params.id);

    if (!post) return res.status(404).json({ message: "Post not found" });

    const userId = req.user._id.toString();

    const alreadySaved = post.favorites.some(
      (id) => id.toString() === userId
    );

    if (alreadySaved) {
      post.favorites = post.favorites.filter(
        (id) => id.toString() !== userId
      );
    } else {
      post.favorites.push(userId);
    }

    await post.save();

    res.json({
      success: true,
      favorites: post.favorites
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Favorite failed" });
  }
});
// Delete Comment from Post
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

// Delete Post
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

// Add this route to check if a post exists
router.get('/posts/:id', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'name profileImage')
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage');
    
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    
    res.json(post);
  } catch (err) {
    console.error("Get Post Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------- User Profile --------------------

// 1. Get Logged-in User's Confessions
// Get User Profile with user data and posts
router.get('/profile/:userId', auth, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Get user profile data
    const profile = await User.findById(userId)
      .select('-password -email')
      .populate('university', 'name')
      .populate('connections', 'name profileImage');
    
    if (!profile) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Get user's posts
    const posts = await Post.find({ author: userId })
      .populate({
        path: 'author',
        select: 'name profileImage university'
      })
      .populate('comments.user', 'name profileImage')
      .populate('likes', 'name profileImage')
      .sort({ createdAt: -1 });

    res.json({ profile, posts });
  } catch (err) {
    console.error("Profile Fetch Error:", err);
    res.status(500).json({ error: "Failed to fetch profile content" });
  }
});

// Get User's Confessions
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

// Get Confession Likes
router.get('/confessions/likes/:id', auth, async (req, res) => {
  try {
    const confession = await Confession.findById(req.params.id);
    if (!confession) return res.status(404).json({ message: "Confession not found" });
    
    // Get user details for each likedBy ID
    const users = await User.find({ _id: { $in: confession.likedBy } })
      .select('name profileImage');
    
    res.json({ likes: users });
  } catch (err) {
    console.error("Get Confession Likes Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
});

// Update Profile
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

// @route   GET api/social/confessions/feed
// @desc    Get feed based on university and connections
// @access  Private
router.get('/confessions/feed', auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id)
      .populate('connections', '_id');
    
    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get IDs of connected users
    const connectedUserIds = currentUser.connections.map(conn => conn._id);
    
    // Get current user's university ID
    const currentUniversityId = currentUser.university;
    
    // Build query: Show confessions where:
    // 1. Author is from same university, OR
    // 2. Author is connected to current user
    const confessions = await Confession.find({
      $or: [
        { university: currentUniversityId }, // Same university
        { authorId: { $in: connectedUserIds } } // Connected users
      ]
    })
    .select('-authorId') // Hide author identity
    .sort({ createdAt: -1 })
    .populate('comments.user', 'name profileImage')
    .lean();

    // Format response with anonymous info
    const formattedConfessions = confessions.map(confession => ({
      ...confession,
      authorName: "Anonymous",
      authorAvatar: null,
      // Check if current user liked this confession
      likedByCurrentUser: confession.likedBy?.includes(req.user._id) || false
    }));

    res.status(200).json(formattedConfessions);
  } catch (err) {
    console.error("Feed Error:", err);
    res.status(500).json({ error: "Could not fetch feed." });
  }
});

// @route   POST api/social/confessions/create
// @desc    Create new confession
// @access  Private
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
    
    // Return the created confession without authorId
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

// @route   PUT api/social/confessions/like/:id
// @desc    Like/unlike a confession
// @access  Private
// Like/Unlike Confession
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

// @route   POST api/social/confessions/comment/:id
// @desc    Add comment to confession
// @access  Private
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

    // Get updated confession with populated comment user info
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

// @route   DELETE api/social/confessions/comment/:postId/:commentId
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


// @route   DELETE api/social/confessions/:id
// Delete Confession
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




// -------------------- STORIES --------------------

// Helper function to check if users can see each other's stories
const canViewStories = async (viewerId, targetId) => {
  const viewer = await User.findById(viewerId).select('connections sentRequests receivedRequests');
  const target = await User.findById(targetId).select('connections sentRequests receivedRequests');
  
  // Can always view own stories
  if (viewerId === targetId) return true;
  
  // Check if they are confirmed connections (mutual)
  const isConnected = viewer.connections.includes(targetId) && target.connections.includes(viewerId);
  if (isConnected) return true;
  
  // Check if viewer has sent a request to target (pending from viewer to target)
  const hasViewerSentRequest = viewer.sentRequests.includes(targetId);
  if (hasViewerSentRequest) return true;
  
  // Check if viewer has received a request from target (pending from target to viewer)
  const hasViewerReceivedRequest = viewer.receivedRequests.includes(targetId);
  if (hasViewerReceivedRequest) return true;
  
  return false;
};

// 1. POST - Upload Story
router.post('/stories/upload', auth, async (req, res) => {
  try {
    const { image, caption } = req.body;
    if (!image) return res.status(400).json({ msg: 'No image provided' });

    const newStory = new Story({
      author: req.userId, 
      image: image,
      caption: caption,
      likes: [],
      seenBy: [],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) 
    });

    const story = await newStory.save();
    const populatedStory = await story.populate('author', 'name profileImage');
    res.json(populatedStory);
  } catch (err) {
    console.error("Upload Error:", err.message);
    res.status(500).json({ msg: 'Server Error during upload' });
  }
});

// 2. GET - Fetch all stories with seen status
router.get('/stories', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    
    const currentUser = await User.findById(currentUserId)
      .select('connections sentRequests receivedRequests');
    
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
        // Add seen status to the story object
        const storyObj = story.toObject();
        storyObj.hasViewed = story.seenBy.includes(currentUserId);
        storyObj.viewCount = story.seenBy.length;
        filteredStories.push(storyObj);
      }
    }
    
    res.json(filteredStories);
  } catch (err) {
    console.error("Fetch Stories Error:", err.message);
    res.status(500).json({ msg: 'Server Error fetching stories' });
  }
});

// 3. PUT - Mark story as seen
router.put('/stories/seen/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ msg: 'Story not found' });

    const currentUserId = req.userId;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ msg: 'You cannot view this story' });
    }

    let isNewView = false;
    if (!story.seenBy.includes(currentUserId)) {
      story.seenBy.push(currentUserId);
      isNewView = true;
      await story.save();
    }
    
    const populatedStory = await Story.findById(story._id)
      .populate('seenBy', 'name profileImage');
    
    res.json({
      seenBy: populatedStory.seenBy,
      viewCount: populatedStory.seenBy.length,
      hasViewed: true,
      isNewView
    });
  } catch (err) {
    console.error("Seen Error:", err.message);
    res.status(500).send('Server Error');
  }
});

// 4. GET - Get viewers list for a story
router.get('/stories/views/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id)
      .populate('seenBy', 'name profileImage');
    
    if (!story) return res.status(404).json({ msg: 'Story not found' });
    
    // Only author can see full viewers list
    const isAuthor = story.author.toString() === req.userId;
    
    res.json({
      viewCount: story.seenBy.length,
      viewers: story.seenBy,
      isAuthor
    });
  } catch (err) {
    console.error("Views Error:", err.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// 5. PUT - Like/Unlike story
router.put('/stories/like/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ msg: 'Story not found' });

    const currentUserId = req.userId;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ msg: 'You cannot interact with this story' });
    }

    const userId = currentUserId.toString();
    
    if (story.likes.includes(userId)) {
      story.likes = story.likes.filter(id => id.toString() !== userId);
    } else {
      story.likes.push(userId);
    }
    
    await story.save();
    
    res.json({ 
      likes: story.likes, 
      likeCount: story.likes.length,
      isLiked: story.likes.includes(userId)
    });
  } catch (err) {
    console.error("Like Error:", err.message);
    res.status(500).json({ msg: 'Server Error liking story' });
  }
});

// 6. POST - Add comment to story
router.post('/stories/comment/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ msg: 'Story not found' });

    const currentUserId = req.userId;
    const storyAuthorId = story.author.toString();
    
    const canView = await canViewStories(currentUserId, storyAuthorId);
    if (!canView) {
      return res.status(403).json({ msg: 'You cannot interact with this story' });
    }

    const newComment = {
      user: currentUserId,
      text: req.body.text,
      createdAt: new Date()
    };

    story.comments.unshift(newComment);
    await story.save();

    const populated = await Story.findById(story._id)
      .populate('comments.user', 'name profileImage');
    
    res.json(populated.comments);
  } catch (err) {
    console.error("Comment Error:", err.message);
    res.status(500).send('Server Error');
  }
});

// 7. DELETE - Delete story
router.delete('/stories/:id', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ msg: 'Story not found' });
    
    if (story.author.toString() !== req.userId.toString()) {
      return res.status(401).json({ msg: 'User not authorized' });
    }

    await story.deleteOne();
    res.json({ msg: 'Story removed' });
  } catch (err) {
    console.error("Delete Error:", err.message);
    res.status(500).json({ msg: 'Server Error deleting story' });
  }
});

// 8. GET - Check visibility status
router.get('/stories/visibility-status/:targetUserId', auth, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const targetUserId = req.params.targetUserId;
    
    const currentUser = await User.findById(currentUserId)
      .select('connections sentRequests receivedRequests');
    const targetUser = await User.findById(targetUserId)
      .select('connections sentRequests receivedRequests');
    
    let canViewStories = false;
    let relationshipStatus = 'none';
    let message = '';
    
    if (currentUserId === targetUserId) {
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
    
    res.json({ canViewStories, relationshipStatus, message });
  } catch (err) {
    console.error("Visibility Check Error:", err.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});



// -------------------- USER & CONNECTIONS --------------------

// 2.  Profile Update
router.put('/profile/update', auth, async (req, res) => {
  try {
    const { name, bio, school, degree } = req.body;

    // We update the User document using the ID from the JWT token
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { 
        $set: { 
          name, 
          bio, 
          // Updating the first element in education array or creating a new one
          education: [{ school, degree }] 
        } 
      },
      { new: true } // Returns the updated document
    );

    res.status(200).json({
      message: "Profile updated successfully",
      user: updatedUser
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile information" });
  }
});

// 3. @route   GET api/social/users/search

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


// 1. --- CONNECTION REQUEST ---
router.post('/user/connect/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    const me = await User.findById(req.user._id);

    if (!me.sentRequests.includes(targetId)) {
      me.sentRequests.push(targetId);
      await me.save();

      // FIXED: Passed 4 arguments to match the helper 
      // Helper expects: (recipient, sender, type, text, relatedId)
      await createNotification(
        targetId,
        req.user._id,
        "request", // Changed from "Connection Request" to match Schema Enum
        `${req.user.name} wants to connect with you.`
      );
    }
    res.json({ success: true, status: "connecting" });
  } catch (err) { 
    console.error("Connect Error:", err.message);
    res.status(500).json({ error: "Server Error" }); 
  }
});

// 2. Accept Request (Run by the receiver)
router.post('/user/accept/:senderId', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    const sender = await User.findById(req.params.senderId);

    if (!me.connections.includes(req.params.senderId)) {
      me.connections.push(req.params.senderId);
      sender.connections.push(req.user.id);

      // Clean up the pending request from the sender
      sender.sentRequests = sender.sentRequests.filter(id => id.toString() !== req.user.id);
      
      await me.save();
      await sender.save();
    }
    res.json({ success: true, status: "connected" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// 2. Accept Request (Run by the other person)
router.post('/user/accept/:senderId', auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    const sender = await User.findById(req.params.senderId);

    if (!me.connections.includes(req.params.senderId)) {
      me.connections.push(req.params.senderId);
      sender.connections.push(req.user.id);

      // Remove from the sender's pending list now that it's official
      sender.sentRequests = sender.sentRequests.filter(id => id.toString() !== req.user.id);
      
      await me.save();
      await sender.save();
    }
    res.json({ success: true, status: "connected" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// 3. Respond to Request (Accept/Decline)
router.post('/notifications/respond', auth, async (req, res) => {
  try {
    const { notificationId, action } = req.body; 
    const notification = await Notification.findById(notificationId)
      .populate('sender', 'name')
      .populate('recipient', 'name');
    
    if (!notification) return res.status(404).json({ error: "Notification not found" });

    // Ensure the person responding is the actual recipient
    if (notification.recipient._id.toString() !== req.user.id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (action === 'accepted') {
      // 1. Update connections for both users ($addToSet prevents duplicates)
      await User.findByIdAndUpdate(notification.recipient, { 
        $addToSet: { connections: notification.sender },
        $pull: { receivedRequests: notification.sender } // Clean up request list
      });
      await User.findByIdAndUpdate(notification.sender, { 
        $addToSet: { connections: notification.recipient },
        $pull: { sentRequests: notification.recipient } // Clean up request list
      });
      
      // 2. Update the original notification (The one User B is looking at)
      notification.status = 'accepted';
      notification.text = "is now a connection.";
      await notification.save();

      // 3. NEW: Send a notification BACK to the original sender (User A)
      // Helper: (recipient, sender, type, text)
      await createNotification(
        notification.sender._id,    // Target: The person who sent the original request
        notification.recipient._id, // Actor: The person who just clicked 'Accept'
        "request",                  // Type
        `${notification.recipient.name} accepted your connection request.` 
      );

    } else {
      // Logic for declining
      notification.status = 'declined';
      notification.text = "request declined.";
      
      // Clean up lists even if declined
      await User.findByIdAndUpdate(notification.recipient, { $pull: { receivedRequests: notification.sender } });
      await User.findByIdAndUpdate(notification.sender, { $pull: { sentRequests: notification.recipient } });
      
      await notification.save();
    }

    res.json({ success: true, notification });
  } catch (err) {
    console.error("Response Error:", err.message);
    res.status(500).json({ error: "Response failed" });
  }
});

// Disconnect user
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
    
    res.json({ success: true, status: "disconnected" });
  } catch (err) {
    console.error("Disconnect Error:", err);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// Cancel sent request
router.post('/user/cancel-request/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { sentRequests: targetId }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to cancel request" });
  }
});

// Reject received request
router.post('/user/reject-request/:targetId', auth, async (req, res) => {
  try {
    const targetId = req.params.targetId;
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { receivedRequests: targetId }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject request" });
  }
});

// Get user's connections list
router.get('/user/connections/:userId', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId)
      .populate('connections', 'name profileImage headline');
    res.json({ connections: user.connections });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch connections" });
  }
});

// -------------------- MESSAGING --------------------

// 1. Get Inbox (Chat List)
// Example of how your Backend 'inbox' route should look:
router.get("/inbox", auth, async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .populate({
        path: "participants",
        select: "name profileImage headline bio location online", // <--- ADD THESE FIELDS
      })
      .sort({ updatedAt: -1 });

    res.json(conversations);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// 2. Get Chat Messages
router.get('/messages/:conversationId', auth, async (req, res) => {
  const messages = await Message.find({ conversationId: req.params.conversationId }).sort({ createdAt: 1 });
  res.json(messages);
});

// routes/social.js
router.post('/conversations/get-or-create', auth, async (req, res) => {
  const { recipientId } = req.body;
  const senderId = req.user.id; // From your auth middleware

  try {
    // Find conversation where BOTH exist in participants array
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

    res.json({ conversationId: conversation._id });
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});
// -------------------- NOTIFICATIONS --------------------

// -------------------- NOTIFICATIONS --------------------

// 1. --- GET NOTIFICATIONS ---
// GET NOTIFICATIONS
router.get('/notifications', auth, async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user._id })
      .populate('sender', 'name profileImage')
      .populate('postId', 'content image') // Populate post details
      .sort({ createdAt: -1 });
    
    // Transform to ensure postId is always present in the response
    const transformedNotifications = notifications.map(notification => {
      const notif = notification.toObject();
      // Ensure postId field exists for frontend
      if (notif.postId) {
        notif.postId = notif.postId._id || notif.postId;
      } else if (notif.relatedId && (notif.type === 'like' || notif.type === 'comment')) {
        notif.postId = notif.relatedId;
      }
      return notif;
    });
    
    res.json(transformedNotifications);
  } catch (err) {
    console.error("Fetch Notifications Error:", err.message);
    res.status(500).json({ message: "Server Error" });
  }
});

// 2. @route   PUT /api/social/notifications/read/:id
// @desc    Mark a specific notification as read
router.put('/notifications/read/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: "Notification not found" });

    // Add user to readBy array if not already there
    if (!notification.readBy.includes(req.user._id)) {
      notification.readBy.push(req.user._id);
      await notification.save();
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ message: "Error updating" });
  }
});

// 3. @desc    Accept or Decline a connection request
router.post('/notifications/respond', auth, async (req, res) => {
  const { notificationId, action } = req.body; // action: 'accepted' or 'declined'

  try {
    const notification = await Notification.findById(notificationId);
    if (!notification) return res.status(404).json({ message: "Notification not found" });

    // Update notification status
    notification.status = action;
    notification.readBy.push(req.user._id); // Mark as read when responded
    await notification.save();

    // Logic: If accepted, add to each other's connection list
    if (action === 'accepted') {
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { connections: notification.sender } });
      await User.findByIdAndUpdate(notification.sender, { $addToSet: { connections: req.user._id } });
      
      // Send confirmation notification back to sender
      const sender = await User.findById(req.user._id);
      await createNotification(
        notification.sender,
        req.user._id,
        'request',
        `${sender.name} accepted your connection request.`
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Response error:", err);
    res.status(500).json({ message: "Error processing response" });
  }
});

// --- MARK ALL AS READ ---
router.put('/notifications/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, readBy: { $ne: req.user._id } },
      { $addToSet: { readBy: req.user._id } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Mark all read error:", err);
    res.status(500).json({ message: "Error updating all" });
  }
});




// Add to routes/social.js
router.delete('/messages/:conversationId', auth, async (req, res) => {
  try {
    await Message.deleteMany({ conversationId: req.params.conversationId });
    await Conversation.findByIdAndUpdate(req.params.conversationId, {
      lastMessage: "Chat cleared",
      updatedAt: Date.now()
    });
    res.json({ success: true, message: "Chat cleared successfully" });
  } catch (err) {
    console.error("Clear chat error:", err);
    res.status(500).json({ error: "Failed to clear chat" });
  }
});
module.exports = router;
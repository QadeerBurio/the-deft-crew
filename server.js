const express = require("express");
const cors = require("cors");
require("dotenv").config();

const http = require("http");
const { Server } = require("socket.io");
const dns = require("dns");
const path = require("path");
const axios = require("axios");

const connectDB = require("./config/db");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// Make io available to routes
app.set('io', io);

// Initialize Event Socket Broadcaster
const eventSocket = require("./socket/eventSocket");
eventSocket.init(io);

// ---------------- DNS CONFIG ----------------
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ---------------- MIDDLEWARE ----------------
app.use(cors());

// ==================== CRITICAL FIX: Handle webhooks BEFORE JSON parser ====================
// Custom middleware to handle webhook raw body
app.use('/api/webhooks', (req, res, next) => {
    let data = '';
    req.on('data', chunk => {
        data += chunk;
    });
    req.on('end', () => {
        // Store raw body
        req.rawBody = data;
        
        // Try to parse JSON, but don't throw error
        try {
            if (data && data.trim()) {
                // Clean the data first - remove BOM, \r\n, etc.
                let cleaned = data;
                // Remove BOM (Byte Order Mark)
                if (cleaned.charCodeAt(0) === 0xFEFF) {
                    cleaned = cleaned.slice(1);
                }
                // Remove \r\n and normalize line endings
                cleaned = cleaned.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
                // Remove multiple spaces
                cleaned = cleaned.replace(/\s+/g, ' ');
                // Trim
                cleaned = cleaned.trim();
                
                if (cleaned) {
                    req.body = JSON.parse(cleaned);
                } else {
                    req.body = {};
                }
            } else {
                req.body = {};
            }
        } catch (e) {
            // If parsing fails, store as string
            console.log('⚠️ Webhook body parsing failed, storing as string:', e.message);
            req.body = data;
        }
        next();
    });
});

// THEN use JSON parser for all other routes
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------------- DATABASE ----------------
connectDB().then(() => {
  // Initialize Automated Event Ingestion Scheduler
  const eventScheduler = require("./services/events/scheduler");
  eventScheduler.initialize();

  // Purge any existing non-Pakistan/worldwide external jobs to keep the feed clean
  const Job = require("./models/Job");
  const JobEmbedding = require("./models/JobEmbedding");
  Job.find({
    location: { $not: /pakistan|karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|gujranwala|hyderabad|abbottabad|sargodha|bahawalpur|sukkur|larkana|gujrat|sheikhupura|jhelum|sahiwal|pk/i }
  }).select("_id").then(async jobsToDelete => {
    if (jobsToDelete.length > 0) {
      const ids = jobsToDelete.map(j => j._id);
      const deleteJobsResult = await Job.deleteMany({ _id: { $in: ids } });
      const deleteEmbeddingsResult = await JobEmbedding.deleteMany({ jobId: { $in: ids } });
      console.log(`🧹 [Startup] Purged ${deleteJobsResult.deletedCount} foreign jobs and ${deleteEmbeddingsResult.deletedCount} orphaned embeddings.`);
    }
  }).catch(err => {
    console.error("❌ [Startup] Failed to purge non-Pakistan jobs:", err);
  });

  // Patch existing admin/manual jobs to ensure flags exist
  Job.updateMany({ isExternal: { $exists: false } }, { $set: { isExternal: false } }).exec();
  Job.updateMany({ active: { $exists: false } }, { $set: { active: true } }).exec();
  Job.updateMany(
    { applicationDeadline: { $exists: false } },
    { $set: { applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) } }
  ).exec();

  const jobIngestionService = require("./services/jobIngestionService");
  jobIngestionService.cleanupExpiredJobs().then(count => {
    if (count > 0) console.log(`⏰ [Startup] Cleaned up ${count} expired jobs.`);
  }).catch(err => {
    console.error("❌ [Startup] Failed to run expired jobs cleanup:", err);
  });

  // Schedule periodic cleanup every 6 hours
  setInterval(() => {
    jobIngestionService.cleanupExpiredJobs().catch(err => {
      console.error("❌ [Periodic] Expired jobs cleanup failed:", err);
    });
  }, 6 * 60 * 60 * 1000);

  const { connectDB: connectChatDB } = require("./chat-service/dist/config/db");
  const { schedulerService } = require("./chat-service/dist/services/scheduler.service");
  connectChatDB().then(() => {
    schedulerService.initialize().catch((err) => {
      console.error("❌ Failed to initialize sync scheduler:", err);
    });
  }).catch((err) => {
    console.error("❌ Failed to connect to chat database:", err);
  });
});

// ---------------- ROUTES ----------------
// IMPORTANT: Register webhook routes FIRST
app.use("/api/webhooks", require("./routes/webhook.routes"));

// Now register all other routes
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/universities", require("./routes/university.routes"));
app.use("/api/offers", require("./routes/offer.routes"));
app.use("/api/brands", require("./routes/brands.routes"));
app.use("/api/notification", require("./routes/notification.routes"));
app.use("/api/profile", require("./routes/profile.routes"));
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/membership", require("./routes/membership.route"));
app.use("/api/bookings", require("./routes/booking.routes"));
app.use("/api/social", require("./routes/social.routes"));
app.use("/api/events", require("./routes/event.routes"));
app.use("/api/jobs", require("./routes/jobs.routes"));
app.use("/api/traveler", require("./routes/traveler.routes"));
app.use("/api/resume", require("./routes/resume.routes"));
app.use("/api/brand-approval", require("./routes/brandApproval.routes"));
app.use("/api/promo-codes", require("./routes/promoCode.routes"));
app.use("/api/v1", require("./chat-service/dist/routes/index").default);

// ============ SKILLSWAP ROUTES ============
app.use('/api/listings', require('./routes/listing.routes'));
app.use('/api/skill-offers', require('./routes/skillOffer.routes'));
app.use('/api/chat', require('./routes/chat.routes'));
app.use('/api/inquiries', require('./routes/inquiry.routes'));

// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
const { Message, Conversation } = require('./models/Chat');

// Global objects
const onlineUsers = new Map(); // { userId: socketId }
const userCallStatus = new Map(); // Track if user is in a call

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // --- TRACK ONLINE STATUS ---
  socket.on('user_online', async (userId) => {
    console.log('User online:', userId);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);

    try {
      const User = require('./models/User');
      await User.findByIdAndUpdate(userId, { online: true });
    } catch (err) {
      console.error('Update online status error:', err);
    }

    io.emit('user_status_update', { userId, status: 'online' });
  });

  // --- GET USER STATUS ---
  socket.on('get_user_status', (userId) => {
    const isOnline = onlineUsers.has(userId);
    socket.emit('user_status_response', {
      userId,
      status: isOnline ? 'online' : 'offline'
    });
  });

  // --- JOIN CHAT ROOM ---
  socket.on('join_chat', (conversationId) => {
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined room ${conversationId}`);
  });

  // --- LEAVE CHAT ROOM ---
  socket.on('leave_chat', (conversationId) => {
    socket.leave(conversationId);
    console.log(`Socket ${socket.id} left room ${conversationId}`);
  });

  // --- SEND MESSAGE ---
  socket.on('send_message', async (data) => {
    try {
      const { conversationId, senderId, text, messageType, mediaUrl, location, duration } = data;

      // Validate required fields
      if (!conversationId || !senderId) {
        console.error('Missing required fields:', { conversationId, senderId });
        return;
      }

      const newMessage = new Message({
        conversationId,
        sender: senderId,
        text: text || '',
        messageType: messageType || 'text',
        mediaUrl: mediaUrl || '',
        location: location || null,
        duration: duration || null
      });

      const savedMessage = await newMessage.save();
      const populatedMessage = await Message.findById(savedMessage._id)
        .populate('sender', 'name profileImage');

      let displayMsg = text;
      if (messageType === 'image') displayMsg = '📷 Photo';
      else if (messageType === 'video') displayMsg = '🎥 Video';
      else if (messageType === 'audio') displayMsg = '🎤 Voice message';
      else if (messageType === 'location') displayMsg = '📍 Location';
      else if (messageType === 'call_log') displayMsg = text;
      else if (!text && messageType !== 'text') displayMsg = 'Media message';

      await Conversation.findByIdAndUpdate(conversationId, {
        $set: {
          lastMessage: displayMsg || 'New message',
          lastMessageType: messageType || 'text',
          lastMessageSender: senderId,
          lastMessageTime: new Date(),
          updatedAt: Date.now()
        },
        $inc: { unreadCount: 1 }
      });

      // Get unread count for the recipient
      const unreadCount = await Message.countDocuments({
        conversationId,
        sender: { $ne: senderId },
        isRead: false
      });

      // Emit to room
      io.to(conversationId).emit('new_message', {
        ...populatedMessage.toObject(),
        unreadCount
      });

      // Also emit to sender for confirmation
      socket.emit('message_sent', populatedMessage);

      // Emit inbox update to all relevant users
      io.emit('inbox_update');

    } catch (err) {
      console.error("Socket Error in send_message:", err);
      socket.emit('message_error', { error: err.message });
    }
  });

  // --- MARK MESSAGES AS READ (Socket) ---
  socket.on('mark_messages_read', async ({ conversationId, userId }) => {
    try {
      await Message.updateMany(
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

      io.to(conversationId).emit('messages_read', { conversationId, userId });
      io.emit('inbox_update');
      console.log(`Messages marked as read in conversation ${conversationId}`);
    } catch (err) {
      console.error('Mark read socket error:', err);
    }
  });

  // --- DELETE MESSAGE ---
  socket.on('delete_message', async ({ messageId, conversationId }) => {
    try {
      console.log('Delete message socket:', messageId);
      const result = await Message.findByIdAndDelete(messageId);
      if (result) {
        // Update last message if needed
        const lastMsg = await Message.findOne({ conversationId })
          .sort({ createdAt: -1 });

        if (lastMsg) {
          await Conversation.findByIdAndUpdate(conversationId, {
            lastMessage: lastMsg.text || 'Media message',
            lastMessageType: lastMsg.messageType,
            lastMessageTime: lastMsg.createdAt
          });
        }

        io.to(conversationId).emit('message_deleted', { messageId });
        io.emit('inbox_update');
        console.log('Message deleted successfully:', messageId);
      }
    } catch (err) {
      console.error('Delete message error:', err);
    }
  });

  // --- DELETE CONVERSATION ---
  socket.on('delete_conversation', async ({ conversationId }) => {
    try {
      console.log('Delete conversation socket:', conversationId);
      io.emit('conversation_deleted', { conversationId });
      io.emit('inbox_update');
      console.log('Conversation deleted socket event sent:', conversationId);
    } catch (err) {
      console.error('Delete conversation socket error:', err);
    }
  });

  // --- TYPING INDICATORS ---
  socket.on('typing_start', ({ conversationId, userId, userName }) => {
    socket.to(conversationId).emit('user_typing', { userId, userName, typing: true });
  });

  socket.on('typing_stop', ({ conversationId, userId }) => {
    socket.to(conversationId).emit('user_typing', { userId, typing: false });
  });

  // ========== WEBRTC CALLING SYSTEM ==========

  // 1. Initiate Call
  socket.on('start_call', ({ senderId, receiverId, senderName, type }) => {
    console.log('Start call:', { senderId, receiverId, senderName, type });

    // Check if user is already in a call
    if (userCallStatus.get(senderId)) {
      socket.emit('call_failed', { reason: 'You are already in a call' });
      return;
    }

    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      // Check if receiver is in a call
      if (userCallStatus.get(receiverId)) {
        socket.emit('call_failed', { reason: 'User is already in a call' });
        return;
      }

      // Store call info
      userCallStatus.set(senderId, { with: receiverId, status: 'calling' });

      // Trigger ringing on receiver's device
      io.to(receiverSocketId).emit('incoming_call', {
        from: senderId,
        name: senderName,
        type: type,
        callerId: senderId
      });
    } else {
      socket.emit('call_failed', { reason: 'User is offline' });
    }
  });

  // 2. Accept Call
  socket.on('accept_call', ({ to, callerId }) => {
    console.log('Accept call:', { to, callerId });
    const callerSocketId = onlineUsers.get(callerId || to);
    if (callerSocketId) {
      // Update call status
      userCallStatus.set(socket.userId, { with: to, status: 'connected' });
      userCallStatus.set(to, { with: socket.userId, status: 'connected' });

      io.to(callerSocketId).emit('call_accepted', {
        from: socket.userId,
        name: socket.userName
      });
    }
  });

  // 3. Reject Call
  socket.on('reject_call', ({ to }) => {
    console.log('Reject call:', { to });
    const callerSocketId = onlineUsers.get(to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call_rejected');
    }
    userCallStatus.delete(socket.userId);
  });

  // 4. End Call
  socket.on('end_call', ({ to }) => {
    console.log('End call:', { to });
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_ended');
    }
    userCallStatus.delete(socket.userId);
    userCallStatus.delete(to);
  });

  // 5. WebRTC Signaling
  socket.on('offer', ({ offer, to }) => {
    console.log('Offer from:', socket.userId, 'to:', to);
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('offer', {
        offer,
        from: socket.userId
      });
    }
  });

  socket.on('answer', ({ answer, to }) => {
    console.log('Answer from:', socket.userId, 'to:', to);
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', {
        answer,
        from: socket.userId
      });
    }
  });

  socket.on('ice_candidate', ({ candidate, to }) => {
    console.log('ICE candidate from:', socket.userId, 'to:', to);
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice_candidate', {
        candidate,
        from: socket.userId
      });
    }
  });

  // --- HANDLE DISCONNECT ---
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);

    if (socket.userId) {
      // End any active calls
      const callInfo = userCallStatus.get(socket.userId);
      if (callInfo) {
        const targetSocketId = onlineUsers.get(callInfo.with);
        if (targetSocketId) {
          io.to(targetSocketId).emit('call_ended');
        }
      }
      userCallStatus.delete(socket.userId);
      onlineUsers.delete(socket.userId);

      try {
        const User = require('./models/User');
        await User.findByIdAndUpdate(socket.userId, { online: false });
      } catch (err) {
        console.error('Update offline error:', err);
      }

      io.emit('user_status_update', {
        userId: socket.userId,
        status: 'offline'
      });
    }
  });
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
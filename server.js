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

// ---------------- DNS CONFIG ----------------
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ---------------- MIDDLEWARE ----------------
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// Static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------------- DATABASE ----------------
connectDB();

// ---------------- ROUTES ----------------
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
app.use("/api/resume", require("./routes/resume.routes"));
app.use("/api/courses", require("./routes/courses.routes"));

// ---------------- AI CHAT (Gemini) ----------------
app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.json({ success: true, reply: "AI key missing" });
  }

  try {
    let conversationHistory = "";
    if (history?.length) {
      history.slice(-6).forEach((m) => {
        conversationHistory += `${m.role}: ${m.content}\n`;
      });
    }

    const prompt = `
You are TDC Assistant.

${conversationHistory}
User: ${message}
Assistant:
`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 500
        }
      }
    );

    const reply =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response";

    res.json({ success: true, reply });
  } catch (err) {
    console.log("AI error:", err.message);
    res.json({ success: true, reply: "Fallback response" });
  }
});

// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
const { Message, Conversation } = require('./models/Chat');

// Global objects
const onlineUsers = new Map(); // { userId: socketId }
const userCallStatus = new Map(); // Track if user is in a call

io.on('connection', (socket) => {
  // console.log('New client connected:', socket.id);
  
  // --- TRACK ONLINE STATUS ---
  socket.on('user_online', (userId) => {
    // console.log('User online:', userId);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);
    io.emit('user_status_update', { userId, status: 'online' });
  });

  socket.on('join_chat', (conversationId) => {
    // console.log('User joined chat:', conversationId);
    socket.join(conversationId);
  });

  socket.on('send_message', async (data) => {
    try {
      // console.log('Send message received:', data);
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
        lastMessage: displayMsg || 'New message',
        updatedAt: Date.now()
      });

      // Emit to room
      io.to(conversationId).emit('new_message', populatedMessage);
      
      // Also emit to sender for confirmation
      socket.emit('message_sent', populatedMessage);
      
      // Emit inbox update to all relevant users
      io.emit('inbox_update');

    } catch (err) {
      console.error("Socket Error in send_message:", err);
      socket.emit('message_error', { error: err.message });
    }
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

  // --- TYPING INDICATORS ---
  socket.on('typing_start', ({ conversationId, userId, userName }) => {
    socket.to(conversationId).emit('user_typing', { userId, userName });
  });

  socket.on('typing_stop', ({ conversationId, userId }) => {
    socket.to(conversationId).emit('user_stop_typing', { userId });
  });

  // --- MARK MESSAGES AS READ ---
  socket.on('mark_read', async ({ conversationId, userId, messageIds }) => {
    try {
      await Message.updateMany(
        { _id: { $in: messageIds }, conversationId },
        { $set: { readBy: userId, readAt: new Date() } }
      );
      socket.to(conversationId).emit('messages_read', { userId, messageIds });
    } catch (err) {
      console.error('Error marking messages as read:', err);
    }
  });

  // --- HANDLE DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.userId);
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
      io.emit('user_status_update', { userId: socket.userId, status: 'offline' });
    }
  });
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
});
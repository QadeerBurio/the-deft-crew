// socket/chatHandlers.js
// The socket.io chat and call handlers, moved unchanged from server.js (SEC-1, move-only) so they can be tested.
// attach(io) registers them; onlineUsers / userCallStatus are the same in-memory maps as before.
// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
const { Message, Conversation } = require('../models/Chat');

// Global objects
const onlineUsers = new Map(); // { userId: socketId }
const userCallStatus = new Map(); // Track if user is in a call

function attach(io) {
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // --- TRACK ONLINE STATUS ---
  // plan P4-1b: the id comes from the sign-in token, never from the client (socket/socketIdentity.js). Older apps
  // without a token keep working only while FLAG_ACCOUNT_STATUS_ENFORCE is off.
  socket.on('user_online', async (clientUserId, tokenArg) => {
    const who = await require('./socketIdentity').resolveOnline(socket, clientUserId, tokenArg).catch(() => ({ refused: true }));
    if (who.refused) return;
    const userId = who.userId;
    console.log('User online:', userId);
    socket.userId = userId;
    onlineUsers.set(userId, socket.id);

    try {
      const User = require('../models/User');
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
      const { 
        conversationId, 
        senderId, 
        text, 
        messageType, 
        mediaUrl,
        mediaMetadata, 
        location, 
        duration 
      } = data;

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
        mediaMetadata: mediaMetadata || undefined,
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
        const User = require('../models/User');
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
}

module.exports = { attach, onlineUsers, userCallStatus };

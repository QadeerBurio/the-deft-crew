// socket/chatHandlers.js
// The socket.io chat and call handlers, moved unchanged from server.js (SEC-1, move-only) so they can be tested.
// attach(io) registers them; onlineUsers / userCallStatus are the same in-memory maps as before.
// ---------------- SOCKET.IO CHAT & CALL HANDLER ----------------
const { Message, Conversation } = require('../models/Chat');

// Global objects
const onlineUsers = new Map(); // { userId: socketId }
const userCallStatus = new Map(); // Track if user is in a call

// SEC-1: the acting user comes from a verified token (socket/socketAuth.js), never from an id the client sends
const sec = require('./socketAuth');

function attach(io) {
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  // SEC-1: a token at the handshake (io(url, { auth: { token } })) identifies the socket at once
  if (socket.handshake?.auth?.token) sec.identify(socket, socket.handshake.auth.token);

  // SEC-1: newer apps send their token right after connecting (older servers ignore this event)
  socket.on('authenticate', (token) => { sec.identify(socket, token); });

  // --- TRACK ONLINE STATUS ---
  // plan P4-1b: the id comes from the sign-in token, never from the client (socket/socketIdentity.js). Older apps
  // without a token keep working only while FLAG_ACCOUNT_STATUS_ENFORCE is off.
  socket.on('user_online', async (clientUserId, tokenArg) => {
    if (typeof tokenArg === 'string' && tokenArg) sec.identify(socket, tokenArg);
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
  socket.on('get_user_status', async (userId) => {
    if (!(await sec.actorOf(socket, 'get_user_status'))) return;
    const isOnline = onlineUsers.has(userId);
    socket.emit('user_status_response', {
      userId,
      status: isOnline ? 'online' : 'offline'
    });
  });

  // --- JOIN CHAT ROOM ---
  socket.on('join_chat', async (conversationId) => {
    const me = await sec.actorOf(socket, 'join_chat');
    if (!me) return;
    // a verified user joins only their own conversations (reading a room = reading its messages)
    if (me.verified && !(await sec.isMember(socket, conversationId, me.id))) {
      console.warn(`[sec-1] join_chat refused: ${me.id} is not in conversation ${String(conversationId).slice(0, 40)}`);
      socket.emit('join_refused', { conversationId });
      return;
    }
    socket.join(conversationId);
    console.log(`Socket ${socket.id} joined room ${conversationId}`);
  });

  // --- LEAVE CHAT ROOM ---
  socket.on('leave_chat', async (conversationId) => {
    if (!(await sec.actorOf(socket, 'leave_chat'))) return;
    socket.leave(conversationId);
    console.log(`Socket ${socket.id} left room ${conversationId}`);
  });

  // --- SEND MESSAGE ---
  socket.on('send_message', async (data) => {
    try {
      const me = await sec.actorOf(socket, 'send_message', data?.senderId);
      if (!me) return;
      const {
        conversationId,
        text,
        messageType, 
        mediaUrl,
        mediaMetadata, 
        location, 
        duration 
      } = data;
      const senderId = me.id; // the token's account (older apps: the id they send)
      if (me.verified && !(await sec.isMember(socket, conversationId, senderId))) {
        console.warn(`[sec-1] send_message refused: ${senderId} is not in conversation ${String(conversationId).slice(0, 40)}`);
        socket.emit('message_error', { error: 'not a member of this conversation' });
        return;
      }

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

      // CHAT-1: a device push to the other participants who aren't in this chat (flag chatPushV1, per recipient)
      setImmediate(() => require('../services/chatPush').pushChatMessage(io, conversationId, senderId, displayMsg || 'new message'));

    } catch (err) {
      console.error("Socket Error in send_message:", err);
      socket.emit('message_error', { error: err.message });
    }
  });

  // --- MARK MESSAGES AS READ (Socket) ---
  socket.on('mark_messages_read', async ({ conversationId, userId: claimedUserId } = {}) => {
    try {
      const me = await sec.actorOf(socket, 'mark_messages_read', claimedUserId);
      if (!me) return;
      const userId = me.id;
      if (me.verified && !(await sec.isMember(socket, conversationId, userId))) return;
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
  socket.on('delete_message', async ({ messageId, conversationId } = {}) => {
    try {
      const me = await sec.actorOf(socket, 'delete_message');
      if (!me) return;
      // a verified user deletes only their own message, in that conversation
      if (me.verified) {
        const m = await Message.findById(messageId).select('sender conversationId').lean().catch(() => null);
        if (m && (String(m.sender) !== me.id || String(m.conversationId) !== String(conversationId))) {
          console.warn(`[sec-1] delete_message refused: ${me.id} is not the sender`);
          return;
        }
      }
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
  socket.on('delete_conversation', async ({ conversationId } = {}) => {
    try {
      const me = await sec.actorOf(socket, 'delete_conversation');
      if (!me) return;
      if (me.verified && !(await sec.isMember(socket, conversationId, me.id))) return;
      console.log('Delete conversation socket:', conversationId);
      io.emit('conversation_deleted', { conversationId });
      io.emit('inbox_update');
      console.log('Conversation deleted socket event sent:', conversationId);
    } catch (err) {
      console.error('Delete conversation socket error:', err);
    }
  });

  // --- TYPING INDICATORS ---
  socket.on('typing_start', async ({ conversationId, userId: claimedUserId, userName: claimedName } = {}) => {
    const me = await sec.actorOf(socket, 'typing_start', claimedUserId);
    if (!me) return;
    if (me.verified && !(await sec.isMember(socket, conversationId, me.id))) return;
    const userId = me.id;
    const userName = me.verified ? me.name : claimedName;
    socket.to(conversationId).emit('user_typing', { userId, userName, typing: true });
  });

  socket.on('typing_stop', async ({ conversationId, userId: claimedUserId } = {}) => {
    const me = await sec.actorOf(socket, 'typing_stop', claimedUserId);
    if (!me) return;
    if (me.verified && !(await sec.isMember(socket, conversationId, me.id))) return;
    const userId = me.id;
    socket.to(conversationId).emit('user_typing', { userId, typing: false });
  });

  // P5a: the SkillShare chats (InquiryChatScreen, MatchChatScreen, every app version) send and listen for 'typing'
  // ({ conversationId, userId, isTyping }), which the server never handled. Relayed to the room with the same checks as
  // typing_start: the token's account, a verified user only into their own conversation.
  socket.on('typing', async ({ conversationId, userId: claimedUserId, isTyping } = {}) => {
    if (!conversationId) return;
    const me = await sec.actorOf(socket, 'typing', claimedUserId);
    if (!me) return;
    if (me.verified && !(await sec.isMember(socket, conversationId, me.id))) return;
    socket.to(String(conversationId)).emit('typing', { conversationId: String(conversationId), userId: me.id, isTyping: !!isTyping });
  });

  // ========== WEBRTC CALLING SYSTEM ==========

  // 1. Initiate Call
  socket.on('start_call', async ({ senderId: claimedSenderId, receiverId, senderName: claimedName, type } = {}) => {
    const me = await sec.actorOf(socket, 'start_call', claimedSenderId);
    if (!me) return;
    const senderId = me.id;
    const senderName = me.verified ? me.name : claimedName;
    console.log('Start call:', { senderId, receiverId, type });

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
  socket.on('accept_call', async ({ to, callerId } = {}) => {
    const me = await sec.actorOf(socket, 'accept_call');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
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
  socket.on('reject_call', async ({ to } = {}) => {
    const me = await sec.actorOf(socket, 'reject_call');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
    console.log('Reject call:', { to });
    const callerSocketId = onlineUsers.get(to);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call_rejected');
    }
    userCallStatus.delete(socket.userId);
  });

  // 4. End Call
  socket.on('end_call', async ({ to } = {}) => {
    const me = await sec.actorOf(socket, 'end_call');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
    console.log('End call:', { to });
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_ended');
    }
    userCallStatus.delete(socket.userId);
    userCallStatus.delete(to);
  });

  // 5. WebRTC Signaling
  socket.on('offer', async ({ offer, to } = {}) => {
    const me = await sec.actorOf(socket, 'offer');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
    console.log('Offer from:', socket.userId, 'to:', to);
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('offer', {
        offer,
        from: socket.userId
      });
    }
  });

  socket.on('answer', async ({ answer, to } = {}) => {
    const me = await sec.actorOf(socket, 'answer');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
    console.log('Answer from:', socket.userId, 'to:', to);
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('answer', {
        answer,
        from: socket.userId
      });
    }
  });

  socket.on('ice_candidate', async ({ candidate, to } = {}) => {
    const me = await sec.actorOf(socket, 'ice_candidate');
    if (!me) return;
    if (me.verified) socket.userId = me.id; // SEC-1: the token's account, not what the client said
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

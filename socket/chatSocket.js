// socket.js - If you want to keep it separate
const { Message, Conversation } = require('../models/Chat');
const User = require('../models/User');
const { sendToUser } = require('../utils/pushNotification');

// Push a chat message to every participant who is NOT looking at this chat
// right now. Covers social DMs, SkillShare match chats and inquiry chats.
async function pushChatMessage(io, conversationId, senderId, displayMsg) {
  try {
    const convo = await Conversation.findById(conversationId).select('participants').lean();
    if (!convo?.participants?.length) return;

    const sender = await User.findById(senderId).select('name').lean();
    const senderName = sender?.name || 'someone';

    // Which kind of chat is it? Decides which screen a tap opens.
    let route = 'MessagesScreen';
    let baseParams = { conversationId: String(conversationId) };
    try {
      const Match = require('../models/Match');
      const match = await Match.findOne({ conversationId }).select('_id listingId').lean();
      if (match) {
        route = 'MatchChat';
        baseParams = { matchId: String(match._id), listingId: match.listingId ? String(match.listingId) : undefined };
      } else {
        const Inquiry = require('../models/Inquiry');
        const inquiry = await Inquiry.findOne({ conversationId }).select('_id listingId').lean();
        if (inquiry) {
          route = 'InquiryChat';
          baseParams = {
            threadId: String(conversationId),
            listingId: inquiry.listingId ? String(inquiry.listingId) : undefined,
            otherParticipantId: String(senderId),
          };
        }
      }
    } catch (e) { /* fall back to MessagesScreen */ }

    // Sockets currently inside this chat room = people actively reading it
    const room = io.sockets.adapter.rooms.get(String(conversationId));
    const viewing = new Set();
    if (room) {
      for (const sid of room) {
        const s = io.sockets.sockets.get(sid);
        if (s?.userId) viewing.add(String(s.userId));
      }
    }

    const preview = displayMsg.length > 80 ? displayMsg.slice(0, 80) + '…' : displayMsg;

    for (const p of convo.participants) {
      const pid = String(p._id || p);
      if (pid === String(senderId) || viewing.has(pid)) continue;
      sendToUser(pid, `${senderName} 💬`, preview, {
        type: 'message',
        mood: 'cheeky',
        senderId: String(senderId),
        conversationId: String(conversationId),
        route,
        params: route === 'InquiryChat' ? baseParams : { ...baseParams },
      }).catch((e) => console.error('[chat push]', e.message));
    }
  } catch (err) {
    console.error('[chat push] error:', err.message);
  }
}

const onlineUsers = new Map();
const userCallStatus = new Map();

module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // --- USER ONLINE STATUS ---
    socket.on('user_online', async (userId) => {
      try {
        socket.userId = userId;
        onlineUsers.set(userId, socket.id);
        
        await User.findByIdAndUpdate(userId, { online: true });
        
        io.emit('user_status_update', { userId, status: 'online' });
        console.log(`User ${userId} is online`);
      } catch (err) {
        console.error('User online error:', err);
      }
    });

    // --- GET USER STATUS ---
    socket.on('get_user_status', async (userId) => {
      try {
        const isOnline = onlineUsers.has(userId);
        socket.emit('user_status_response', { 
          userId, 
          status: isOnline ? 'online' : 'offline' 
        });
      } catch (err) {
        console.error('Get status error:', err);
      }
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
        const { conversationId, senderId, text, messageType, mediaUrl, duration } = data;

        const newMessage = new Message({
          conversationId,
          sender: senderId,
          text: text || '',
          messageType: messageType || 'text',
          mediaUrl: mediaUrl || '',
          duration: duration || 0
        });
        
        const savedMessage = await newMessage.save();
        const populatedMessage = await Message.findById(savedMessage._id)
          .populate('sender', 'name profileImage');

        let displayMsg = text || 'Media message';
        if (messageType === 'image') displayMsg = '📷 Photo';
        else if (messageType === 'video') displayMsg = '🎥 Video';
        else if (messageType === 'audio') displayMsg = '🎤 Voice message';
        else if (messageType === 'location') displayMsg = '📍 Location';
        else if (messageType === 'call_log') displayMsg = text || 'Call log';

        await Conversation.findByIdAndUpdate(
          conversationId,
          {
            $set: {
              lastMessage: displayMsg,
              lastMessageType: messageType || 'text',
              lastMessageSender: senderId,
              lastMessageTime: new Date(),
              updatedAt: new Date()
            },
            $inc: { unreadCount: 1 }
          }
        );

        const unreadCount = await Message.countDocuments({
          conversationId,
          sender: { $ne: senderId },
          isRead: false
        });

        io.to(conversationId).emit('new_message', {
          ...populatedMessage.toObject(),
          unreadCount
        });

        io.emit('inbox_update');
        console.log(`Message sent to conversation ${conversationId}`);

        // ✅ Device push for people not in this chat (app closed / other screen)
        if (messageType !== 'call_log') {
          setImmediate(() => pushChatMessage(io, conversationId, senderId, displayMsg));
        }
      } catch (err) {
        console.error('Send message error:', err);
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // --- MARK MESSAGES AS READ ---
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
      } catch (err) {
        console.error('Mark read socket error:', err);
      }
    });
// Add this to your socket.js file inside the module.exports

// --- DELETE CONVERSATION ---
socket.on('delete_conversation', async ({ conversationId }) => {
  try {
    // Emit to all users that conversation was deleted
    io.emit('conversation_deleted', { conversationId });
    io.emit('inbox_update');
    console.log(`Conversation ${conversationId} deleted via socket`);
  } catch (err) {
    console.error('Delete conversation socket error:', err);
  }
});
    // --- DELETE MESSAGE ---
    socket.on('delete_message', async ({ messageId, conversationId }) => {
      try {
        await Message.findByIdAndDelete(messageId);
        
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
      } catch (err) {
        console.error('Delete message error:', err);
      }
    });

    // --- TYPING INDICATOR ---
    socket.on('typing_start', ({ conversationId, userId, userName }) => {
      socket.to(conversationId).emit('user_typing', { userId, userName, typing: true });
    });

    socket.on('typing_stop', ({ conversationId, userId }) => {
      socket.to(conversationId).emit('user_typing', { userId, typing: false });
    });

    // --- CALL SYSTEM ---
    socket.on('start_call', ({ senderId, receiverId, senderName, type }) => {
      if (userCallStatus.get(senderId)) {
        socket.emit('call_failed', { reason: 'You are already in a call' });
        return;
      }
      
      const receiverSocketId = onlineUsers.get(receiverId);
      if (receiverSocketId) {
        if (userCallStatus.get(receiverId)) {
          socket.emit('call_failed', { reason: 'User is already in a call' });
          return;
        }
        
        userCallStatus.set(senderId, { with: receiverId, status: 'calling' });
        
        io.to(receiverSocketId).emit('incoming_call', {
          from: senderId,
          name: senderName || 'User',
          type: type || 'voice',
          callerId: senderId
        });
      } else {
        socket.emit('call_failed', { reason: 'User is offline' });
      }
    });

    socket.on('accept_call', ({ to, callerId }) => {
      const callerSocketId = onlineUsers.get(callerId || to);
      if (callerSocketId) {
        userCallStatus.set(socket.userId, { with: to, status: 'connected' });
        userCallStatus.set(to, { with: socket.userId, status: 'connected' });
        
        io.to(callerSocketId).emit('call_accepted', {
          from: socket.userId
        });
      }
    });

    socket.on('reject_call', ({ to }) => {
      const callerSocketId = onlineUsers.get(to);
      if (callerSocketId) {
        io.to(callerSocketId).emit('call_rejected');
      }
      userCallStatus.delete(socket.userId);
    });

    socket.on('end_call', ({ to }) => {
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call_ended');
      }
      userCallStatus.delete(socket.userId);
      userCallStatus.delete(to);
    });

    // --- WEBRTC SIGNALING ---
    socket.on('offer', ({ offer, to }) => {
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('offer', {
          offer,
          from: socket.userId
        });
      }
    });

    socket.on('answer', ({ answer, to }) => {
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('answer', {
          answer,
          from: socket.userId
        });
      }
    });

    socket.on('ice_candidate', ({ candidate, to }) => {
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('ice_candidate', {
          candidate,
          from: socket.userId
        });
      }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', async () => {
      console.log('Client disconnected:', socket.id);
      
      if (socket.userId) {
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
};
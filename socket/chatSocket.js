const { Message, Conversation } = require('../models/Chat');

// Global objects
const onlineUsers = new Map(); // { userId: socketId }
const userCallStatus = new Map(); // Track if user is in a call

module.exports = (io) => {
  io.on('connection', (socket) => {
    
    // --- TRACK ONLINE STATUS ---
    socket.on('user_online', (userId) => {
      socket.userId = userId;
      onlineUsers.set(userId, socket.id);
      io.emit('user_status_update', { userId, status: 'online' });
    });

    socket.on('join_chat', (conversationId) => {
      socket.join(conversationId);
    });

    socket.on('send_message', async (data) => {
      try {
        const { conversationId, senderId, text, messageType, mediaUrl, location, duration } = data;

        const newMessage = new Message({
          conversationId,
          sender: senderId,
          text,
          messageType: messageType || 'text',
          mediaUrl,
          location,
          duration
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

        await Conversation.findByIdAndUpdate(conversationId, {
          lastMessage: displayMsg,
          updatedAt: Date.now()
        });

        io.to(conversationId).emit('new_message', populatedMessage);
        io.emit('inbox_update');

      } catch (err) {
        console.error("Socket Error:", err);
      }
    });

    // ========== WEBRTC CALLING SYSTEM ==========
    
    // 1. Initiate Call
    socket.on('start_call', ({ senderId, receiverId, senderName, type }) => {
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
      const callerSocketId = onlineUsers.get(to);
      if (callerSocketId) {
        io.to(callerSocketId).emit('call_rejected');
      }
      userCallStatus.delete(socket.userId);
    });

    // 4. End Call
    socket.on('end_call', ({ to }) => {
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call_ended');
      }
      userCallStatus.delete(socket.userId);
      userCallStatus.delete(to);
    });

    // 5. WebRTC Signaling
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

    // --- HANDLE DISCONNECT ---
    socket.on('disconnect', () => {
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
};
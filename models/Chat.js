const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Conversation",
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  text: String,
  messageType: {
    type: String,
    enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'call_log'],
    default: 'text'
  },
  mediaUrl: String,
  mediaMetadata: {
    fileName: String,
    fileSize: Number,
    fileType: String,
    duration: Number
  },
  location: {
    latitude: Number,
    longitude: Number
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const conversationSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  }],
  lastMessage: {
    type: String,
    default: "Start a conversation..."
  },
  lastMessageSender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  lastMessageType: {
    type: String,
    enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'call_log'],
    default: 'text'
  },
  lastMessageTime: {
    type: Date,
    default: Date.now
  },
  unreadCount: {
    type: Number,
    default: 0
  },
  isMuted: {
    type: Boolean,
    default: false
  },
  isArchived: {
    type: Boolean,
    default: false
  },
  pinned: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for performance
conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ isArchived: 1 });
conversationSchema.index({ isMuted: 1 });

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, isRead: 1 });

module.exports = {
  Message: mongoose.model("Message", messageSchema),
  Conversation: mongoose.model("Conversation", conversationSchema)
};
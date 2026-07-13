// models/Chat.js
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
    duration: Number // For audio/video
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
    text: String,
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    createdAt: Date,
    messageType: String
  },
  unreadCount: {
    type: Number,
    default: 0
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster queries
conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, isRead: 1 });

module.exports = {
  Message: mongoose.model("Message", messageSchema),
  Conversation: mongoose.model("Conversation", conversationSchema)
};
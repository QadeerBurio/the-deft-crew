const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  conversationId:{
    type: mongoose.Schema.Types.ObjectId,
    ref:"Conversation"
  },
  sender:{
    type: mongoose.Schema.Types.ObjectId,
    ref:"User"
  },
  text:String,
  messageType: { 
    type: String, 
    enum: ['text', 'image', 'video', 'audio', 'document', 'location', 'call_log'], // Added 'call_log'
    default: 'text' 
  },
  mediaUrl: String, // URL from Cloudinary/S3
  location: {
    latitude: Number,
    longitude: Number
  },
  duration: { type: Number }, // For voice messages
  createdAt:{
    type:Date,
    default:Date.now
  }
});

const conversationSchema = new mongoose.Schema({
  participants:[{
    type: mongoose.Schema.Types.ObjectId,
    ref:"User"
  }],
  lastMessage:String,
  
  updatedAt:{
    type:Date,
    default:Date.now
  }
});

module.exports = {
  Message:mongoose.model("Message",messageSchema),
  Conversation:mongoose.model("Conversation",conversationSchema)
};
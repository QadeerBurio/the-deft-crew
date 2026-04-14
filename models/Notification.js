const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema({

  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  title: {
    type: String,
    required: true
  },

  description: {
    type: String,
    required: true
  },

  type: {
    type: String,
    enum: ["All", "Offers", "System"],
    default: "System"
  },
  icon: String,
  link: String,

  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deletedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  expoPushToken: { type: String, default: null }

}, { timestamps: true });

module.exports = mongoose.model("Notification", NotificationSchema);
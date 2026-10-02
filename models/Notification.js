const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true, // Make this required - never null
    index: true // Add index for faster queries
  },
  sender: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  },
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
    enum: [
      // System
      "System", "Alert", "Update", "Welcome", "Reminder", "Promotion",
      "Security", "Payment", "Card", "Transaction", "Booking",
      // Jobs / career
      "Job Application", "Job Posting", "Application Status", "Interview",
      "Jobs", "Scholarship", "Course", "Exchange",
      // Social
      "Message", "Social", "Like", "Comment", "Follow",
      // Offers
      "Offer", "Brand",
      // Engagement
      "Badge", "LevelUp", "Streak", "Points", "Reward",
    ],
    default: "System",
 
   
  },
  icon: {
    type: String,
    default: "bell"
  },
   // ✅ Mood drives the in-app banner emoji
    mood: {
      type: String,
      default: 'sorted',
      enum: [
        'sorted',
        'excited',
        'sleepy',
        'panic',
        'sus',
        'cheeky',
        'shook',
        'hype',
        'smug',
        'shock',
        'broke',
        'money',
        'ghost',
        'urgent',
      ],
    },

  link: {
    type: String,
    default: ""
  },
  readBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  deletedBy: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }],
  
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { 
  timestamps: true 
});

// Index for faster queries
NotificationSchema.index({ recipient: 1, createdAt: -1 });
NotificationSchema.index({ readBy: 1 });
NotificationSchema.index({ deletedBy: 1 });

module.exports = mongoose.model("Notification", NotificationSchema);
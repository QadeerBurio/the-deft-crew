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
      "System", 
      "Job Application", 
      "Job Posting", 
      "Application Status", 
      "Message", 
      "Event", 
      "Offer", 
      "Alert", 
      "Reminder", 
      "Welcome", 
      "Interview",
      "Exchange",
      "Scholarship",
      "Course",
      "Booking",
      "Card",
      "Payment",
      "Jobs",
      "Update",
      "Promotion",
      "Brand",
      "Security",
    ],
    default: "System"
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


// ═══════════════════════════════════════════════════════════════
// AUTO PUSH — every new Notification also goes to the user's phone
// (deals, promo codes, redemptions, payments, jobs, events, admin...).
// Routes only need Notification.create(); no extra push code.
// Skip with: Notification.create({..., metadata: { skipPush: true } })
// ═══════════════════════════════════════════════════════════════
const DEAL_RE = /promo|redeem|redemption|voucher|saved|payment|paid|discount|deal|offer|order|claim|coupon|card|gold|wallet|refund/i;
const JOB_RE = /job|intern|interview|application|applicant|hiring|career/i;

function classify(doc) {
  const t = doc.type || 'System';
  const text = `${doc.title || ''} ${doc.description || ''} ${doc.icon || ''}`;
  if (t === 'Message') return { pushType: 'message', mood: 'cheeky', route: 'MessagesScreen' };
  if (t === 'Event') return { pushType: 'event', mood: 'excited', route: 'Events' };
  if (t === 'Reminder') return { pushType: 'reminder', mood: 'panic', route: 'NotificationModal' };
  if (t === 'Alert') return { pushType: 'System', mood: 'urgent', route: 'NotificationModal' };
  if (['Job Application', 'Job Posting', 'Application Status', 'Interview', 'Jobs'].includes(t) || (t === 'System' && JOB_RE.test(text) && !DEAL_RE.test(text))) {
    return { pushType: 'new_job', mood: 'hype', route: 'TDCCareers' };
  }
  if (t === 'Payment' || t === 'Card') return { pushType: 'new_offer', mood: 'money', route: 'MyDiscountScreen' };
  if (['Offer', 'Promotion', 'Brand'].includes(t) || DEAL_RE.test(text)) {
    return { pushType: 'new_offer', mood: /saved|paid|payment|redeem|used|confirmed/i.test(text) ? 'money' : 'excited', route: 'MyDiscountScreen' };
  }
  if (t === 'Welcome') return { pushType: 'System', mood: 'hype', route: 'Home' };
  return { pushType: 'System', mood: 'sorted', route: 'NotificationModal' };
}

// Mongoose 9: no next() in pre hooks (calling it throws "next is not a function")
NotificationSchema.pre('save', function () {
  this.$locals.wasNew = this.isNew;
});

NotificationSchema.post('save', function (doc) {
  if (!doc.$locals?.wasNew) return;
  const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  if (meta.skipPush || process.env.DISABLE_NOTIFICATION_PUSH === 'true') return;

  setImmediate(async () => {
    try {
      const { sendToUser } = require('../utils/pushNotification');
      const c = classify(doc);
      const mood = doc.mood && doc.mood !== 'sorted' ? doc.mood : c.mood;
      await sendToUser(doc.recipient, doc.title, doc.description, {
        ...meta,
        notificationId: doc._id.toString(),
        notificationType: doc.type,
        type: meta.pushType || c.pushType,
        mood,
        link: doc.link || null,
        route: meta.route || meta.screen || c.route,
        params: meta.params || {},
      });
    } catch (err) {
      console.error('[Notification auto-push]', err.message);
    }
  });
});

module.exports = mongoose.model("Notification", NotificationSchema);
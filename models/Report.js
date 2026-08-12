const mongoose = require('mongoose');

const ReportSchema = new mongoose.Schema({
  reporterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reportedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  contentId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'contentType'
  },
  contentType: {
    type: String,
    enum: ['Post', 'Comment', 'Confession', 'User']
  },
  reason: {
    type: String,
    enum: [
      'Spam',
      'Harassment',
      'Hate Speech',
      'Sexual Content',
      'Violence',
      'Misinformation',
      'Inappropriate Content',
      'Fake Account',
      'Other'
    ],
    required: true
  },
  description: {
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    enum: ['pending', 'under_review', 'resolved', 'rejected'],
    default: 'pending'
  },
  adminNotes: {
    type: String,
    maxlength: 1000
  },
  actionTaken: {
    type: String,
    enum: ['none', 'warning', 'content_removed', 'user_suspended', 'user_banned', 'user_blocked']
  },
  resolvedAt: Date,
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for performance
ReportSchema.index({ status: 1, createdAt: -1 });
ReportSchema.index({ reporterId: 1 });
ReportSchema.index({ reportedUserId: 1 });
ReportSchema.index({ contentId: 1 });

module.exports = mongoose.model('Report', ReportSchema);
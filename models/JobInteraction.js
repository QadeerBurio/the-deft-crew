// models/JobInteraction.js
// Stores user interactions with internships to enable behavioral personalization and feedback loops.

const mongoose = require('mongoose');

const JobInteractionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  interactionType: {
    type: String,
    enum: ['view', 'save', 'apply', 'ignore', 'dismiss'],
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for high performance
// 1. Get all interactions for a user to calculate affinity vectors
JobInteractionSchema.index({ userId: 1, createdAt: -1 });

// 2. Prevent duplicate logged actions of the same type within a short time, or check if specific job is already interacted with
JobInteractionSchema.index({ userId: 1, jobId: 1, interactionType: 1 });

module.exports = mongoose.model('JobInteraction', JobInteractionSchema);

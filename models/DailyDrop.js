// models/DailyDrop.js
const mongoose = require('mongoose');

const dropSchema = new mongoose.Schema(
  {
    dayKey: { type: String, required: true, unique: true },
    type: {
      type: String,
      enum: ['internship', 'brand', 'confession', 'event', 'scholarship', 'poll', 'best_confession'],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    image: { type: String, default: '' },
    mood: { type: String, default: 'excited' },
    contentRef: {
      kind: { type: String, default: null },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    action: {
      kind: {
        type: String,
        enum: ['react', 'vote', 'save', 'rsvp', 'interest', 'match'],
        default: 'react',
      },
      options: { type: [String], default: [] },
    },
    publishAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'live', 'archived'],
      default: 'draft',
    },
    pushedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DailyDrop', dropSchema);
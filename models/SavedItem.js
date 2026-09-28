// models/SavedItem.js
const mongoose = require('mongoose');

const savedSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['scholarship', 'trip'], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deadline: { type: Date, default: null },
  },
  { timestamps: true }
);

savedSchema.index({ user: 1, kind: 1, refId: 1 }, { unique: true });

module.exports = mongoose.model('SavedItem', savedSchema);
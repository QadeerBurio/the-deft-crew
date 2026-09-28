// models/DropReaction.js
const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema(
  {
    drop: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyDrop', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    choice: { type: String, required: true },
  },
  { timestamps: true }
);

reactionSchema.index({ drop: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('DropReaction', reactionSchema);
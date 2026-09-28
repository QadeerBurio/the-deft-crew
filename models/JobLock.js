// models/JobLock.js
const mongoose = require('mongoose');

const lockSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // `${jobName}:${dayKey}`
  lockedAt: { type: Date, default: Date.now },
  owner: { type: String, default: null },
});

module.exports = mongoose.model('JobLock', lockSchema);
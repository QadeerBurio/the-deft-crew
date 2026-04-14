// models/Application.js
const mongoose = require('mongoose');

const ApplicationSchema = new mongoose.Schema({
  programId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExchangeProgram', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  formData: Object, // Stores all the fields from your React Native state
  experiences: Array,
  appliedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Application', ApplicationSchema);
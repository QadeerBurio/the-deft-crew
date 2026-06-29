const mongoose = require('mongoose');

const ExchangeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  university: { type: String, required: true },
  location: { type: String, required: true },
  degree: { 
    type: String, 
    enum: ['Bachelors', 'Masters', 'PhD', 'Exchange'], 
    default: 'Bachelors' 
  },
  appStart: { type: String, required: true },
  deadline: { type: String, required: true },
  duration: { type: String, required: true },
  requirements: [{ type: String }],
  link: { type: String, default: '' },
  active: { type: Boolean, default: true },
  scholarship: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Scholarships' // Updated to match the model name
  }
}, { timestamps: true });

module.exports = mongoose.model('Exchange', ExchangeSchema);
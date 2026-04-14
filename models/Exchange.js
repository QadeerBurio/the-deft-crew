const mongoose = require('mongoose');

const ExchangeSchema = new mongoose.Schema({
  title: { type: String, required: true },
  university: { type: String, required: true },
  location: { type: String, required: true },
  degree: { 
    type: String, 
    enum: ['Bachelors', 'Masters', 'PhD'], 
    default: 'Bachelors' 
  },
  appStart: { type: String, required: true },
  deadline: { type: String, required: true },
  duration: { type: String, required: true },
  requirements: [{ type: String }], // <--- Added this line
  color: { type: String, default: '#1B1B1B' },
  active: { type: Boolean, default: true },
  link: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Exchange', ExchangeSchema);
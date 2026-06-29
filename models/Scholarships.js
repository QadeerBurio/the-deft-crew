const mongoose = require('mongoose');

const scholarshipSchema = new mongoose.Schema({
  programId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Exchange',
    required: true
  },
  name: {
    type: String,
    required: true
  },
  amount: {
    type: String,
    default: ''
  },
  currency: {
    type: String,
    default: 'USD'
  },
  description: {
    type: String,
    default: ''
  },
  deadline: {
    type: Date
  },
  requirements: [{
    type: String
  }],
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Scholarships', scholarshipSchema);
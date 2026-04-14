const mongoose = require('mongoose');

const PackageSchema = new mongoose.Schema({
  name: { type: String, required: true },
  location: String,
  category: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
  requirements: [String],
  inclusions: [String],
  image: String, 
  createdAt: { type: Date, default: Date.now }
});

// FIX: You must export the model so other files can use it
module.exports = mongoose.model('Package', PackageSchema);
// models/Slider.js
const mongoose = require('mongoose');
const SliderSchema = new mongoose.Schema({
  type: { type: String, enum: ['slider', 'offer'], default: 'slider' },
  title: String,
  description: String,
  link: String,
  image: String,
  category: String,
  discountPercentage: Number,
  location: String,
  redeemInstructions: String,
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('Slider', SliderSchema);
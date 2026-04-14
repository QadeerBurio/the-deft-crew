const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, enum: ['modern', 'classic', 'creative', 'professional', 'executive', 'minimal', 'tech', 'academic'], required: true },
  description: { type: String, required: true },
  previewImage: { type: String },
  thumbnailUrl: { type: String },
  colors: [{ type: String }],
  fonts: {
    heading: { type: String, default: 'Helvetica-Bold' },
    body: { type: String, default: 'Helvetica' }
  },
  layout: { type: String, enum: ['single-column', 'two-column', 'three-column', 'sidebar-left', 'sidebar-right'], default: 'single-column' },
  bestFor: [{ type: String }],
  industries: [{ type: String }],
  experienceLevel: [{ type: String, enum: ['entry', 'mid', 'senior', 'executive'] }],
  isActive: { type: Boolean, default: true },
  popularity: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Ensure the model is properly exported
const Template = mongoose.model('Template', templateSchema);
module.exports = Template;
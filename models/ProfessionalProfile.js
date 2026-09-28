const mongoose = require('mongoose');

const professionalProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },
  photoUrl: { type: String, default: '' },
  fullName: { type: String, trim: true, default: '' },
  headline: { type: String, trim: true, default: '' },
  university: { type: String, trim: true, default: '' },
  fieldOfStudy: { type: String, trim: true, default: '' },
  bio: { type: String, trim: true, default: '' },
  skills: [{ type: String, trim: true }],
  portfolioLinks: [{ type: String, trim: true }],
  interestedCategories: [{ type: String, trim: true }],
  servicesProvided: [{ type: String, trim: true }],
  startingRate: { type: Number, default: 0, min: 0 },
  rateCurrency: { type: String, default: 'PKR' },
  workMode: { type: String, enum: ['remote', 'on-site', 'both'], default: 'both' },
  availabilityPerWeek: { type: String, default: '10-20 hrs/week' },
  lastCompletedStep: { type: Number, default: 0, min: 0, max: 5 },
  isComplete: { type: Boolean, default: false },
  completedAt: { type: Date },
}, { timestamps: true });

professionalProfileSchema.index( { unique: true });

module.exports = mongoose.model('ProfessionalProfile', professionalProfileSchema);
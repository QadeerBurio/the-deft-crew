const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: ["barter", "paid", "job"]
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  skillOffered: {
    skillName: { 
      type: String,
      trim: true,
      required: [
        function() { return this.type === 'barter' || this.type === 'paid'; },
        'skillOffered.skillName is required for barter and paid listings'
      ] 
    },
    yearsOfExperience: { 
      type: Number, 
      min: 0,
      required: [
        function() { return this.type === 'barter' || this.type === 'paid'; },
        'skillOffered.yearsOfExperience is required for barter and paid listings'
      ] 
    },
    proficiencyLevel: {
      type: String,
      enum: ["beginner", "intermediate", "advanced", "expert"],
      required: [
        function() { return this.type === 'barter' || this.type === 'paid'; },
        'skillOffered.proficiencyLevel is required for barter and paid listings'
      ]
    },
    portfolioLinks: { 
      type: [String], 
      default: [],
      validate: {
        validator: function(links) {
          return links.every(link => !link || link.startsWith('http'));
        },
        message: 'Portfolio links must be valid URLs'
      }
    },
    experienceDetails: { 
      type: String,
      trim: true
    }
  },
  skillWanted: {
    skillName: { 
      type: String,
      trim: true,
      required: [
        function() { return this.type === 'barter'; },
        'skillWanted.skillName is required for barter listings'
      ]
    },
    notes: { 
      type: String,
      trim: true
    }
  },
  price: {
    type: Number,
    min: 0,
    required: [
      function() { return this.type === 'paid'; },
      'price is required for paid listings'
    ]
  },
  duration: {
    type: String,
    trim: true,
    required: [
      function() { return this.type === 'paid'; },
      'duration is required for paid listings'
    ]
  },
  syllabus: {
    type: String,
    trim: true
  },
  skillNeeded: {
    skillName: {
      type: String,
      trim: true,
      required: [
        function() { return this.type === 'job'; },
        'skillNeeded.skillName is required for job listings'
      ]
    },
    experienceLevel: {
      type: String,
      enum: ["beginner", "intermediate", "advanced", "expert"]
    },
    notes: { 
      type: String,
      trim: true
    }
  },
  budget: {
    type: Number,
    min: 0,
    required: [
      function() { return this.type === 'job'; },
      'budget is required for job listings'
    ]
  },
  positionsAvailable: {
    type: Number,
    min: 1,
    required: [
      function() { return this.type === 'job'; },
      'positionsAvailable is required for job listings'
    ]
  },
  positionsFilled: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    required: true,
    default: "open",
    enum: ["open", "matched", "closed"]
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
listingSchema.index({ ownerId: 1, status: 1 });
listingSchema.index({ type: 1, status: 1 });
listingSchema.index({ createdAt: -1 });

// Virtual for checking if listing is full (for job listings)
listingSchema.virtual('isFull').get(function() {
  if (this.type !== 'job') return false;
  return this.positionsFilled >= this.positionsAvailable;
});

module.exports = mongoose.model('Listing', listingSchema);
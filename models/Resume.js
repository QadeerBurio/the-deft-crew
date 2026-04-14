const mongoose = require('mongoose');

const educationSchema = new mongoose.Schema({
  school: { type: String },
  degree: { type: String },
  startDate: { type: String },
  endDate: { type: String },
  description: { type: String, default: '' }
});

const experienceSchema = new mongoose.Schema({
  company: { type: String },
  title: { type: String },
  startDate: { type: String },
  endDate: { type: String },
  desc: { type: String, default: '' },
  description: { type: String, default: '' }
});

const projectSchema = new mongoose.Schema({
  name: { type: String },
  description: { type: String, default: '' },
  technologies: [{ type: String }],
  link: { type: String, default: '' }
});

const certificationSchema = new mongoose.Schema({
  name: { type: String },
  issuer: { type: String },
  date: { type: String }
});

const languageSchema = new mongoose.Schema({
  language: { type: String },
  level: { 
    type: String, 
    default: 'Basic',
    enum: ['Basic', 'Conversational', 'Professional', 'Native']
  }
});

const resumeSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  
  // Personal Information
  fullName: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  address: { type: String, default: '' },
  linkedin: { type: String, default: '' },
  github: { type: String, default: '' },
  portfolio: { type: String, default: '' },
  website: { type: String, default: '' },
  
  // Professional Summary
  summary: { type: String, default: '' },
  
  // Sections
  education: [educationSchema],
  experience: [experienceSchema],
  projects: [projectSchema],
  certifications: [certificationSchema],
  languages: [languageSchema],
  skills: [{ type: String }],
  
  // Template Preferences - FIXED: Removed enum restriction
  templateId: { 
    type: String, 
    default: 'modern_001'  // Now accepts any template ID like 'special_003', 'modern_001', etc.
  },
  savedTemplates: [{ type: String }],
  
  // Sharing & Analytics
  publicUrl: { type: String, unique: true, sparse: true },
  isPublic: { type: Boolean, default: false },
  viewCount: { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },
  
  // Version Control
  version: { type: Number, default: 1 },
  
  // Status
  isComplete: { type: Boolean, default: false },
  completionScore: { type: Number, default: 0 },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Calculate completion score
resumeSchema.methods.calculateCompletionScore = function() {
  let score = 0;
  if (this.fullName && this.fullName.trim()) score += 10;
  if (this.email && this.email.trim()) score += 10;
  if (this.phone && this.phone.trim()) score += 10;
  if (this.summary && this.summary.length > 50) score += 15;
  if (this.experience && this.experience.length > 0) score += 20;
  if (this.education && this.education.length > 0) score += 15;
  if (this.skills && this.skills.length >= 5) score += 15;
  if (this.projects && this.projects.length > 0) score += 5;
  return Math.min(score, 100);
};

// Generate public URL
resumeSchema.methods.generatePublicUrl = function() {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256')
    .update(`${this.userId}${Date.now()}`)
    .digest('hex')
    .substring(0, 12);
  this.publicUrl = hash;
  return hash;
};

// Pre-save middleware
resumeSchema.pre('save', function() {
  this.completionScore = this.calculateCompletionScore();
  this.updatedAt = Date.now();
  
  // Ensure description field is populated from desc for compatibility
  if (this.experience) {
    this.experience.forEach(exp => {
      if (exp.desc && !exp.description) {
        exp.description = exp.desc;
      }
      if (exp.description && !exp.desc) {
        exp.desc = exp.description;
      }
    });
  }
  
  
});

const Resume = mongoose.model('Resume', resumeSchema);
module.exports = Resume;
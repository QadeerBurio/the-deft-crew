const mongoose = require('mongoose');

const lessonSchema = new mongoose.Schema({
  id: { type: String, required: true },
  title: { type: String, required: true },
  time: { type: String, required: true },
  type: { type: String, enum: ['video', 'practice', 'lab', 'assignment'], default: 'video' },
  videoUrl: { type: String },
  content: { type: String },
  isCompleted: { type: Boolean, default: false }
});

const moduleSchema = new mongoose.Schema({
  id: { type: String, required: true },
  title: { type: String, required: true },
  lessons: [lessonSchema]
});

const courseSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  category: { 
    type: String, 
    required: true, 
    enum: ['ds', 'ai', 'fs', 'cs'],
    uppercase: false
  },
  title: { type: String, required: true },
  provider: { type: String, default: 'TechDegree Club' },
  instructor: {
    name: { type: String, default: 'TechDegree Team' },
    role: { type: String, default: 'Instructor' },
    avatar: { type: String },
    bio: { type: String }
  },
  rating: { type: Number, default: 4.5, min: 0, max: 5 },
  reviews: { type: Number, default: 0 },
  level: { 
    type: String, 
    enum: ['Beginner', 'Intermediate', 'Advanced'], 
    required: true 
  },
  duration: { type: String, required: true },
  image: { type: String, required: true },
  color: { type: String, default: '#3b82f6' },
  skills: [{ type: String }],
  description: { type: String, required: true },
  modules: [moduleSchema],
  courseUrl: { type: String },
  isActive: { type: Boolean, default: true },
  enrolledCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt field on save
courseSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
});

module.exports = mongoose.model('Course', courseSchema);
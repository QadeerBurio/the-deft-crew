const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
    title: { 
        type: String, 
        required: [true, "Job title is required"],
        trim: true
    },
    department: { 
        type: String, 
        required: [true, "Department is required"],
        trim: true
    },
    category: {
        type: String,
        enum: ["Technology", "Marketing", "Sales", "Finance", "HR", "Operations", "Design", "Other"],
        default: "Technology"
    },
    location: { 
        type: String, 
        required: [true, "Location is required"],
        trim: true
    },
    locationType: {
        type: String,
        enum: ["Remote", "On-site", "Hybrid"],
        default: "On-site"
    },
    type: { 
        type: String, 
        required: [true, "Job type is required"],
        enum: ["Full-time", "Part-time", "Contract", "Internship", "Temporary"],
        default: "Full-time"
    },
    salary: { 
        type: String, 
        required: [true, "Salary range is required"],
        trim: true
    },
    salaryMin: {
        type: Number,
        default: 0
    },
    salaryMax: {
        type: Number,
        default: 0
    },
    currency: {
        type: String,
        default: "USD"
    },
    email: { 
        type: String, 
        required: [true, "Contact email is required"],
        lowercase: true,
        trim: true
    },
    description: { 
        type: String, 
        required: [true, "Job description is required"],
        trim: true
    },
    requirements: [{ 
        type: String,
        trim: true
    }],
    responsibilities: [{ 
        type: String,
        trim: true
    }],
    benefits: [{ 
        type: String,
        trim: true
    }],
    experienceLevel: {
        type: String,
        enum: ["Entry Level", "Mid Level", "Senior Level", "Executive", "Director"],
        default: "Mid Level"
    },
    minExperience: {
        type: Number,
        default: 0
    },
    education: {
        type: String,
        enum: ["High School", "Associate Degree", "Bachelor's Degree", "Master's Degree", "PhD", "Not Specified"],
        default: "Bachelor's Degree"
    },
    skills: [{ 
        type: String,
        trim: true
    }],
    active: { 
        type: Boolean, 
        default: true 
    },
    featured: {
        type: Boolean,
        default: false
    },
    urgent: {
        type: Boolean,
        default: false
    },
    applicationDeadline: {
        type: Date,
        default: () => new Date(+new Date() + 30*24*60*60*1000)
    },
    totalApplications: {
        type: Number,
        default: 0
    },
    views: {
        type: Number,
        default: 0
    },
    postedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    companyName: {
        type: String,
        default: ""
    },
    companyLogo: {
        type: String,
        default: ""
    },
    companyWebsite: {
        type: String,
        default: ""
    },
    // --- JOB INGESTION PIPELINE & IMPORT METADATA FIELDS ---
    source: {
        type: String,
        default: 'manual'
    },
    sourceFile: {
        type: String,
        default: ''
    },
    importBatch: {
        type: String,
        default: ''
    },
    batchExpiresAt: {
        type: Date
    },
    externalId: {
        type: String,
        default: ''
    },
    externalUrl: {
        type: String,
        default: ''
    },
    isExternal: {
        type: Boolean,
        default: false
    },
    lastFetchedAt: {
        type: Date
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// ==================== PERFORMANCE INDEXES ====================
// Critical for public job feed queries (eliminates collection scans)
JobSchema.index({ active: 1, type: 1, createdAt: -1 });          // Main feed
JobSchema.index({ active: 1, category: 1, locationType: 1 });    // Category filters
JobSchema.index({ active: 1, featured: -1, urgent: -1 });        // Featured/urgent jobs
JobSchema.index({ active: 1, applicationDeadline: 1, type: 1 }); // Deadline queries with type
JobSchema.index({ companyName: 1, title: 1, location: 1 });      // Exact matching for deduplication
JobSchema.index({ postedBy: 1, active: 1 });                     // Employer dashboard
JobSchema.index({ skills: 1 });                                  // Skill matching
JobSchema.index({ source: 1, externalId: 1 }, { sparse: true }); // Deduplication

JobSchema.pre('save', function() {
    this.updatedAt = Date.now();
});

module.exports = mongoose.model('Job', JobSchema);
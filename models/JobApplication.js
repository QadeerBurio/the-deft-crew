const mongoose = require('mongoose');

const JobApplicationSchema = new mongoose.Schema({
    jobId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Job',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Personal Information
    fullName: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    phone: {
        type: String,
        required: true
    },
    address: {
        type: String,
        default: ""
    },
    city: {
        type: String,
        default: ""
    },
    country: {
        type: String,
        default: ""
    },
    // Professional Information
    coverLetter: {
        type: String,
        required: true
    },
    resumeUrl: {
        type: String,
        default: ""
    },
    resumePublicId: {
        type: String,
        default: ""
    },
    resumeFileName: {
        type: String,
        default: ""
    },
    portfolioUrl: {
        type: String,
        default: ""
    },
    linkedInUrl: {
        type: String,
        default: ""
    },
    githubUrl: {
        type: String,
        default: ""
    },
    currentCompany: {
        type: String,
        default: ""
    },
    currentPosition: {
        type: String,
        default: ""
    },
    yearsOfExperience: {
        type: Number,
        default: 0
    },
    // Additional Questions
    expectedSalary: {
        type: String,
        default: ""
    },
    noticePeriod: {
        type: String,
        default: ""
    },
    availableFrom: {
        type: Date
    },
    workAuthorization: {
        type: String,
        enum: ["Citizen", "Permanent Resident", "Work Visa", "Need Sponsorship", "Other"],
        default: "Citizen"
    },
    // Status Tracking
    status: {
        type: String,
        enum: ["pending", "reviewed", "shortlisted", "interview", "rejected", "hired"],
        default: "pending"
    },
    notes: {
        type: String,
        default: ""
    },
    interviewDate: {
        type: Date
    },
    interviewNotes: {
        type: String,
        default: ""
    },
    rating: {
        type: Number,
        min: 1,
        max: 5,
        default: null
    },
    appliedAt: {
        type: Date,
        default: Date.now
    },
    reviewedAt: {
        type: Date
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
});

// ==================== PERFORMANCE INDEXES ====================
// Critical for employer pipeline dashboards and student application views
JobApplicationSchema.index({ jobId: 1, status: 1 });            // Employer: filter by status per job
JobApplicationSchema.index({ userId: 1, appliedAt: -1 });       // Student: my applications sorted by date
JobApplicationSchema.index({ userId: 1, jobId: 1 }, { unique: true }); // Prevent duplicate applications
JobApplicationSchema.index({ status: 1, appliedAt: -1 });       // Admin: overview by status

module.exports = mongoose.model('JobApplication', JobApplicationSchema);
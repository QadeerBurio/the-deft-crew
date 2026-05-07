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
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

JobSchema.pre('save', function() {
    this.updatedAt = Date.now();
});

module.exports = mongoose.model('Job', JobSchema);
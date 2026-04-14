const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
    title: { type: String, required: true },
    department: { type: String, required: true },
    location: { type: String, required: true }, // e.g., "Karachi / Remote"
    type: { type: String, required: true },     // e.g., "Full-time", "Contract"
    salary: { type: String, required: true },
    email: { type: String, required: true },
    description: { type: String, required: true },
    requirements: [{ type: String }],           // Array of strings
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Job', JobSchema);
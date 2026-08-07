const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Job = require('../models/Job');
const jobIngestionService = require('../services/jobIngestionService');

async function testExpiration() {
    try {
        const uri = process.env.MONGO_URI || process.env.BACKEND_MONGO_URI;
        await mongoose.connect(uri);
        console.log("🔗 Connected to MongoDB.");

        const activeCountBefore = await Job.countDocuments({ active: true, importBatch: '2026-08-07' });
        console.log(`Active listings imported for 2026-08-07 batch: ${activeCountBefore}`);

        // Verify metadata fields
        const sampleDoc = await Job.findOne({ importBatch: '2026-08-07' }).lean();
        console.log("\nSample Imported Record Metadata:");
        console.log({
            id: sampleDoc._id,
            title: sampleDoc.title,
            companyName: sampleDoc.companyName,
            sourceFile: sampleDoc.sourceFile,
            importBatch: sampleDoc.importBatch,
            batchExpiresAt: sampleDoc.batchExpiresAt,
            applicationDeadline: sampleDoc.applicationDeadline,
            active: sampleDoc.active
        });

        // Run cleanup with current date (Aug 7, 2026) -> should deactivate 0 items
        const cleanedNow = await jobIngestionService.cleanupExpiredJobs();
        const activeCountNow = await Job.countDocuments({ active: true, importBatch: '2026-08-07' });
        console.log(`\nCleanup result today (Aug 7): ${cleanedNow} deactivated. Active remaining: ${activeCountNow}`);

        await mongoose.disconnect();
        console.log("🔗 Test complete.");
    } catch (err) {
        console.error("Test failed:", err);
    }
}

testExpiration();

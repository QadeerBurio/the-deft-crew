const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Job = require('../models/Job');

async function deduplicateAndCleanup() {
    try {
        const uri = process.env.MONGO_URI || process.env.BACKEND_MONGO_URI;
        console.log("🔗 Connecting to MongoDB...");
        await mongoose.connect(uri);
        console.log("✅ Connected.");

        // 1. Find duplicate listings based on companyName + title + location
        const allJobs = await Job.find({}).sort({ createdAt: 1 });
        const dupMap = new Map();
        let deactivatedDups = 0;

        for (const job of allJobs) {
            const key = `${(job.companyName || '').trim().toLowerCase()}|${(job.title || '').trim().toLowerCase()}|${(job.location || '').trim().toLowerCase()}`;
            if (dupMap.has(key)) {
                // Deactivate the newer duplicate
                if (job.active) {
                    await Job.findByIdAndUpdate(job._id, { active: false, updatedAt: new Date() });
                    deactivatedDups++;
                    console.log(`🔒 Deactivated duplicate: "${job.title}" at "${job.companyName}" (ID: ${job._id})`);
                }
            } else {
                dupMap.set(key, job._id);
            }
        }

        // 2. Run Expiration Check against current time
        const now = new Date();
        const expiredResult = await Job.updateMany(
            { active: true, applicationDeadline: { $lt: now } },
            { $set: { active: false, updatedAt: now } }
        );

        console.log("\n==================== DEDUPLICATION & CLEANUP RESULTS ====================");
        console.log(`Deactivated Duplicates: ${deactivatedDups}`);
        console.log(`Deactivated Expired Listings: ${expiredResult.modifiedCount}`);
        console.log("=========================================================================");

        await mongoose.disconnect();
        console.log("🔗 Disconnected from MongoDB.");
    } catch (err) {
        console.error("❌ Cleanup failed:", err);
    }
}

deduplicateAndCleanup();

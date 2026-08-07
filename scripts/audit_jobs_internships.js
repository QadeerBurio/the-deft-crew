const mongoose = require('mongoose');
const path = require('path');
const http = require('http');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Job = require('../models/Job');

function parseDateFromText(text) {
    if (!text) return null;
    // Regex matches common deadline patterns in Pakistan job ads:
    // e.g. "Deadline: 15 August 2026", "Last Date to Apply: 30-07-2026", "Apply before July 31, 2026", etc.
    const patterns = [
        /(?:deadline|last\s*date|apply\s*before|closing\s*date|due\s*date)[:\s]+([0-9]{1,2}[-/\s]+[A-Za-z]+[-/\s]+[0-9]{4})/i,
        /(?:deadline|last\s*date|apply\s*before|closing\s*date|due\s*date)[:\s]+([A-Za-z]+[-/\s]+[0-9]{1,2}[,/-]*\s*[-/\s]*[0-9]{4})/i,
        /(?:deadline|last\s*date|apply\s*before|closing\s*date|due\s*date)[:\s]+([0-9]{1,2}[-/\.][0-9]{1,2}[-/\.][0-9]{2,4})/i
    ];

    for (const pat of patterns) {
        const match = text.match(pat);
        if (match && match[1]) {
            const parsed = new Date(match[1]);
            if (!isNaN(parsed.getTime())) {
                return { rawText: match[0], extracted: match[1], parsedDate: parsed };
            }
        }
    }
    return null;
}

async function runDetailedAudit() {
    try {
        const uri = process.env.MONGO_URI || process.env.BACKEND_MONGO_URI;
        await mongoose.connect(uri);
        const allListings = await Job.find({}).lean();

        console.log(`\n==================== DETAILED FIELD ANALYSIS (${allListings.length} LISTINGS) ====================`);

        const now = new Date();
        let syntheticDeadlineCount = 0; // Deadlines set exactly 30 days after createdAt
        let extractedDeadlinesFromText = [];
        let sourcesBreakdown = {};
        let locationBreakdown = {};
        let missingFields = { companyName: 0, title: 0, location: 0, applicationUrl: 0, description: 0 };
        let duplicates = [];
        let urlList = [];

        for (const item of allListings) {
            // Source breakdown
            const src = item.source || 'manual';
            sourcesBreakdown[src] = (sourcesBreakdown[src] || 0) + 1;

            // Location breakdown
            const loc = item.location || 'Unknown';
            locationBreakdown[loc] = (locationBreakdown[loc] || 0) + 1;

            // Missing fields
            if (!item.companyName) missingFields.companyName++;
            if (!item.title) missingFields.title++;
            if (!item.location) missingFields.location++;
            if (!item.externalUrl && !item.email && !item.companyWebsite) missingFields.applicationUrl++;
            if (!item.description) missingFields.description++;

            // Synthetic deadline check (if applicationDeadline - createdAt is roughly 30 days)
            if (item.applicationDeadline && item.createdAt) {
                const diffDays = Math.round((new Date(item.applicationDeadline) - new Date(item.createdAt)) / (1000 * 60 * 60 * 24));
                if (diffDays === 30) {
                    syntheticDeadlineCount++;
                }
            }

            // Text deadline extraction
            const textMatch = parseDateFromText(item.description);
            if (textMatch) {
                const isPast = textMatch.parsedDate < now;
                extractedDeadlinesFromText.push({
                    id: item._id.toString(),
                    title: item.title,
                    company: item.companyName,
                    storedDeadline: item.applicationDeadline,
                    extracted: textMatch.extracted,
                    parsedDate: textMatch.parsedDate.toISOString().split('T')[0],
                    isExpired: isPast,
                    activeInDB: item.active
                });
            }

            if (item.externalUrl) {
                urlList.push({ id: item._id.toString(), url: item.externalUrl, company: item.companyName });
            }
        }

        console.log(`Sources Breakdown:`, JSON.stringify(sourcesBreakdown, null, 2));
        console.log(`Synthetic 30-day Default Deadlines Count: ${syntheticDeadlineCount} / ${allListings.length}`);
        console.log(`Missing Fields Summary:`, JSON.stringify(missingFields, null, 2));
        console.log(`Extracted Text Deadlines Found: ${extractedDeadlinesFromText.length}`);

        if (extractedDeadlinesFromText.length > 0) {
            console.log("\nSample Extracted Deadlines from Descriptions:");
            console.table(extractedDeadlinesFromText);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error("Detailed Audit Error:", err);
    }
}

runDetailedAudit();

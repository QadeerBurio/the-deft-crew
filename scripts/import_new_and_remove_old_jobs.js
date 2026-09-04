const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Job = require('../models/Job');
const User = require('../models/User');
const { Event } = require('../models/Event');
const Resume = require('../models/Resume');
const JobApplication = require('../models/JobApplication');

// Helper to parse CSV cleanly
function parseCSV(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];
    
    const parseRow = (text) => {
        const result = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '"') {
                if (inQuotes && text[i+1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(cur.trim());
                cur = '';
            } else {
                cur += char;
            }
        }
        result.push(cur.trim());
        return result;
    };

    const headers = parseRow(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseRow(lines[i]);
        if (values.length >= Math.min(headers.length - 2, 3)) {
            const rowObj = {};
            headers.forEach((h, idx) => {
                rowObj[h] = values[idx] || '';
            });
            rows.push(rowObj);
        }
    }
    return rows;
}

// Helper to parse Excel
function parseExcel(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(worksheet);
}

// Category mapping helper
function mapCategory(deptOrCat) {
  const cat = (deptOrCat || '').toLowerCase().trim();
  if (cat.includes('cs') || cat.includes('software') || cat.includes('it') || cat.includes('tech') || cat.includes('computer') || cat.includes('web') || cat.includes('dev')) {
    return 'Technology';
  }
  if (cat.includes('market') || cat.includes('digital') || cat.includes('social media') || cat.includes('content') || cat.includes('seo')) {
    return 'Marketing';
  }
  if (cat.includes('sale') || cat.includes('business dev') || cat.includes('outreach')) {
    return 'Sales';
  }
  if (cat.includes('finance') || cat.includes('account') || cat.includes('audit') || cat.includes('tax')) {
    return 'Finance';
  }
  if (cat.includes('hr') || cat.includes('human') || cat.includes('recruit')) {
    return 'HR';
  }
  if (cat.includes('design') || cat.includes('graphics') || cat.includes('ui') || cat.includes('ux') || cat.includes('creative') || cat.includes('media')) {
    return 'Design';
  }
  if (cat.includes('operation') || cat.includes('logistics') || cat.includes('supply')) {
    return 'Operations';
  }
  return 'Other';
}

function mapLocationType(location) {
  const loc = (location || '').toLowerCase();
  if (loc.includes('remote')) return 'Remote';
  if (loc.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

async function performReplacement() {
    try {
        const uri = process.env.MONGO_URI;
        console.log("🔗 Connecting to MongoDB...");
        await mongoose.connect(uri);
        console.log("✅ Connected to MongoDB.\n");

        // Baseline counts of unrelated collections
        const initialUserCount = await User.countDocuments();
        const initialEventCount = await Event.countDocuments();
        const initialResumeCount = await Resume.countDocuments();
        const initialAppCount = await JobApplication.countDocuments();
        const initialTotalJobsCount = await Job.countDocuments();

        console.log("==================== BEFORE REPLACEMENT BASELINE ====================");
        console.log(`- Total Jobs in DB: ${initialTotalJobsCount}`);
        console.log(`- Users: ${initialUserCount}`);
        console.log(`- Events: ${initialEventCount}`);
        console.log(`- Resumes: ${initialResumeCount}`);
        console.log(`- Applications: ${initialAppCount}`);

        // 1. Identify records originating from the 4 old files
        const oldFiles = [
            { name: 'Karachi_Internships_2026 (1).xlsx', path: path.join(__dirname, '../Karachi_Internships_2026 (1).xlsx') },
            { name: 'Karachi_Internships_2026.xlsx', path: path.join(__dirname, '../Karachi_Internships_2026.xlsx') },
            { name: 'Karachi_Lahore_Islamabad_Jobs_Internships.csv', path: path.join(__dirname, '../Karachi_Lahore_Islamabad_Jobs_Internships.csv') },
            { name: 'ai_studio_code.csv', path: path.join(__dirname, '../ai_studio_code.csv') },
            { name: 'FRESH_Verified_Live_7Aug2026_Jobs.csv', path: path.join(__dirname, '../FRESH_Verified_Live_7Aug2026_Jobs.csv') },
            { name: 'NEW_Jobs_Batch2_7Aug2026.csv', path: path.join(__dirname, '../NEW_Jobs_Batch2_7Aug2026.csv') }
        ];

        const oldKeysSet = new Set();
        const oldFileCounts = {};

        for (const file of oldFiles) {
            const rows = file.path.endsWith('.xlsx') ? parseExcel(file.path) : parseCSV(file.path);
            oldFileCounts[file.name] = rows.length;
            for (const r of rows) {
                const title = r['Internship Title'] || r['Title'] || r['Job Title'] || r['job_title'] || r['title'];
                const company = r['Company Name'] || r['Company'] || r['company_name'] || r['company'];
                if (title && company) {
                    oldKeysSet.add(`${company.trim().toLowerCase()}|${title.trim().toLowerCase()}`);
                }
            }
        }

        // Find exact DB jobs to delete
        const allCurrentJobs = await Job.find({}).lean();
        const targetIdsToDelete = [];

        for (const j of allCurrentJobs) {
            const key = `${(j.companyName || '').trim().toLowerCase()}|${(j.title || '').trim().toLowerCase()}`;
            if (oldKeysSet.has(key) || j.source === 'manual') {
                targetIdsToDelete.push(j._id);
            }
        }

        console.log(`\nFound ${targetIdsToDelete.length} matching old listings to safely delete.`);

        // Perform targeted delete ONLY for identified old listings
        let deletedCount = 0;
        if (targetIdsToDelete.length > 0) {
            const deleteResult = await Job.deleteMany({ _id: { $in: targetIdsToDelete } });
            deletedCount = deleteResult.deletedCount;
            console.log(`✅ Safely deleted ${deletedCount} target old listings.`);
        }

        // 2. Import the 2 NEW CSV files
        const newFiles = [
            { name: 'NEW_Jobd_Batch4_01Sep2026.csv', path: path.join(__dirname, '../NEW_Jobs_Batch4_01Sep2026.csv') },
            
        ];

        const importDate = new Date('2026-08-07T00:00:00.000Z');
        const batchExpiresAt = new Date('2026-08-22T23:59:59.999Z'); // 15 days retention from Aug 7, 2026

        let totalImported = 0;
        let totalDuplicatesSkipped = 0;
        let totalInvalidSkipped = 0;
        const newImportReport = [];
        const processedDupsSet = new Set();

        for (const file of newFiles) {
            const rows = parseCSV(file.path);
            let importedForFile = 0;
            let dupsForFile = 0;
            let invalidForFile = 0;

            for (const r of rows) {
                const title = r['Job Title'] || r['Title'] || r['Internship Title'];
                const companyName = r['Company'] || r['Company Name'];
                const location = r['Location'] || 'Karachi, Pakistan';
                const applyLink = r['Application Link'] || r['Backup Search Link'] || r['Link'] || '';
                const department = r['Department'] || 'General';
                const jobTypeRaw = r['Job Type'] || 'Full-time';
                const source = r['Source'] || 'Indeed';

                if (!title || !companyName) {
                    invalidForFile++;
                    continue;
                }

                // Check deduplication key
                const dupKey = `${companyName.trim().toLowerCase()}|${title.trim().toLowerCase()}|${location.trim().toLowerCase()}`;
                if (processedDupsSet.has(dupKey)) {
                    dupsForFile++;
                    continue;
                }
                processedDupsSet.add(dupKey);

                // Category & LocationType mapping
                const category = mapCategory(department);
                const locationType = mapLocationType(location);

                // Determine job vs internship type
                let jobType = 'Full-time';
                if (jobTypeRaw.toLowerCase().includes('intern') || title.toLowerCase().includes('intern') || department.toLowerCase().includes('intern')) {
                    jobType = 'Internship';
                } else if (jobTypeRaw.toLowerCase().includes('part')) {
                    jobType = 'Part-time';
                } else if (jobTypeRaw.toLowerCase().includes('contract')) {
                    jobType = 'Contract';
                }

                // Build Job document
                const newJobDoc = new Job({
                    title: title.trim(),
                    companyName: companyName.trim(),
                    department: department.trim(),
                    category,
                    location: location.trim(),
                    locationType,
                    type: jobType,
                    salary: 'Competitive / Stipend',
                    email: 'hello@deftcrew.com',
                    description: `${title} at ${companyName}.\nTarget Audience: ${r['Target Audience'] || 'Freshers / Students'}\nFreshness: ${r['Freshness (verified)'] || 'Verified Aug 2026'}`,
                    requirements: [
                        `Target Audience: ${r['Target Audience'] || 'Freshers'}`,
                        `Source: ${source}`
                    ],
                    skills: [department, category, jobType],
                    isExternal: true,
                    externalUrl: applyLink.trim(),
                    source,
                    sourceFile: file.name,
                    importBatch: '2026-08-07',
                    batchExpiresAt,
                    applicationDeadline: batchExpiresAt, // 15-day batch expiration date
                    active: true,
                    createdAt: importDate,
                    updatedAt: importDate
                });

                await newJobDoc.save();
                importedForFile++;
            }

            totalImported += importedForFile;
            totalDuplicatesSkipped += dupsForFile;
            totalInvalidSkipped += invalidForFile;

            newImportReport.push({
                file: file.name,
                found: rows.length,
                imported: importedForFile,
                duplicates: dupsForFile,
                invalid: invalidForFile
            });
        }

        console.log("\n==================== REPLACEMENT SUMMARY ====================");
        console.log(`- Old Jobs Deleted: ${deletedCount}`);
        console.log(`- New Jobs Imported: ${totalImported}`);
        console.log(`- Duplicates Skipped: ${totalDuplicatesSkipped}`);
        console.log(`- Invalid Rows Skipped: ${totalInvalidSkipped}`);

        // 3. Post-verification of safety
        const finalUserCount = await User.countDocuments();
        const finalEventCount = await Event.countDocuments();
        const finalResumeCount = await Resume.countDocuments();
        const finalAppCount = await JobApplication.countDocuments();
        const finalTotalJobsCount = await Job.countDocuments();

        console.log("\n==================== AFTER REPLACEMENT SAFETY VERIFICATION ====================");
        console.log(`- Total Jobs in DB: ${finalTotalJobsCount}`);
        console.log(`- Users: ${finalUserCount} (Match: ${finalUserCount === initialUserCount})`);
        console.log(`- Events: ${finalEventCount} (Match: ${finalEventCount === initialEventCount})`);
        console.log(`- Resumes: ${finalResumeCount} (Match: ${finalResumeCount === initialResumeCount})`);
        console.log(`- Applications: ${finalAppCount} (Match: ${finalAppCount === initialAppCount})`);

        await mongoose.disconnect();
        console.log("\n🔗 Disconnected from MongoDB.");
    } catch (err) {
        console.error("❌ Replacement failed:", err);
    }
}

performReplacement();

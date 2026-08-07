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

async function auditAndReport() {
    try {
        const uri = process.env.MONGO_URI || process.env.BACKEND_MONGO_URI;
        await mongoose.connect(uri);
        console.log("🔗 Connected to MongoDB.");

        const oldFiles = [
            { name: 'Karachi_Internships_2026 (1).xlsx', path: path.join(__dirname, '../Karachi_Internships_2026 (1).xlsx') },
            { name: 'Karachi_Internships_2026.xlsx', path: path.join(__dirname, '../Karachi_Internships_2026.xlsx') },
            { name: 'Karachi_Lahore_Islamabad_Jobs_Internships.csv', path: path.join(__dirname, '../Karachi_Lahore_Islamabad_Jobs_Internships.csv') },
            { name: 'ai_studio_code.csv', path: path.join(__dirname, '../ai_studio_code.csv') }
        ];

        const newFiles = [
            { name: 'FRESH_Verified_Live_7Aug2026_Jobs.csv', path: path.join(__dirname, '../FRESH_Verified_Live_7Aug2026_Jobs.csv') },
            { name: 'NEW_Jobs_Batch2_7Aug2026.csv', path: path.join(__dirname, '../NEW_Jobs_Batch2_7Aug2026.csv') }
        ];

        console.log("\n==================== 1. OLD DATA AUDIT ====================");
        let totalOldRows = 0;
        const oldKeysSet = new Set();
        const oldFileBreakdown = [];

        for (const file of oldFiles) {
            let rows = [];
            if (file.path.endsWith('.xlsx')) {
                rows = parseExcel(file.path);
            } else {
                rows = parseCSV(file.path);
            }
            console.log(`- ${file.name}: ${rows.length} records`);
            totalOldRows += rows.length;

            let fileMatchCount = 0;
            for (const row of rows) {
                const title = row['Internship Title'] || row['Title'] || row['Job Title'] || row['job_title'] || row['title'];
                const company = row['Company Name'] || row['Company'] || row['company_name'] || row['company'];
                if (title && company) {
                    const normKey = `${company.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
                    oldKeysSet.add(normKey);
                    fileMatchCount++;
                }
            }
            oldFileBreakdown.push({ file: file.name, rowCount: rows.length, parsedKeys: fileMatchCount });
        }

        console.log(`\nTotal Old Records Across 4 Files: ${totalOldRows}`);
        console.log(`Unique (Company + Title) Keys in Old Files: ${oldKeysSet.size}`);

        console.log("\n==================== 2. DATABASE PRE-CHECK ====================");
        const allJobsInDB = await Job.find({}).lean();
        console.log(`Total listings in Job collection: ${allJobsInDB.length}`);

        const userCount = await User.countDocuments();
        const eventCount = await Event.countDocuments();
        const resumeCount = await Resume.countDocuments();
        const applicationCount = await JobApplication.countDocuments();

        console.log(`\nUnrelated Collections Baseline Counts:`);
        console.log(`- Users: ${userCount}`);
        console.log(`- Events: ${eventCount}`);
        console.log(`- Resumes: ${resumeCount}`);
        console.log(`- Job Applications: ${applicationCount}`);

        // Find DB listings matching the old files
        const dbMatchingOld = [];
        const dbUnrelated = [];

        for (const job of allJobsInDB) {
            const key = `${(job.companyName || '').trim().toLowerCase()}|${(job.title || '').trim().toLowerCase()}`;
            // If the key is in oldKeysSet OR source is 'manual' (the imported source tag used by the old scripts)
            if (oldKeysSet.has(key) || job.sourceFile || job.source === 'manual') {
                dbMatchingOld.push(job._id);
            } else {
                dbUnrelated.push(job._id);
            }
        }

        console.log(`\nIdentified Target Old Listings in DB to Remove: ${dbMatchingOld.length}`);
        console.log(`Identified Non-Target / External Listings to Keep: ${dbUnrelated.length}`);

        console.log("\n==================== 3. NEW DATA AUDIT ====================");
        let totalNewRows = 0;
        const newFileBreakdown = [];

        for (const file of newFiles) {
            const rows = parseCSV(file.path);
            console.log(`- ${file.name}: ${rows.length} records`);
            if (rows.length > 0) {
                console.log(`  Columns (${Object.keys(rows[0]).length}): ${Object.keys(rows[0]).join(', ')}`);
            }
            totalNewRows += rows.length;
            newFileBreakdown.push({ file: file.name, count: rows.length, rows });
        }
        console.log(`Total New Records Across 2 Files: ${totalNewRows}`);

        await mongoose.disconnect();
    } catch (err) {
        console.error("Audit error:", err);
    }
}

auditAndReport();

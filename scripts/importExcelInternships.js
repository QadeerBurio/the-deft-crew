// scripts/importExcelInternships.js
// ============================================================
// Script to import internships from Karachi_Internships_2026.xlsx 
// and Karachi_Internships_2026 (1).xlsx into the Job collection.
// Deduplicates and triggers job embedding generation.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');
const Job = require('../models/Job');
const { generateJobEmbedding } = require('../services/jobEmbeddingService');

// Category mapping helper
function mapCategory(sheetCategory) {
  const cat = (sheetCategory || '').toLowerCase().trim();
  if (cat.includes('cs') || cat.includes('software') || cat.includes('it') || cat.includes('tech') || cat.includes('computer')) {
    return 'Technology';
  }
  if (cat.includes('market') || cat.includes('digital')) {
    return 'Marketing';
  }
  if (cat.includes('sale') || cat.includes('business dev')) {
    return 'Sales';
  }
  if (cat.includes('finance') || cat.includes('account') || cat.includes('audit')) {
    return 'Finance';
  }
  if (cat.includes('hr') || cat.includes('human') || cat.includes('recruit')) {
    return 'HR';
  }
  if (cat.includes('design') || cat.includes('graphics') || cat.includes('ui') || cat.includes('ux') || cat.includes('creative')) {
    return 'Design';
  }
  if (cat.includes('operation') || cat.includes('logistics') || cat.includes('supply')) {
    return 'Operations';
  }
  return 'Other';
}

// Location type mapping helper
function mapLocationType(location) {
  const loc = (location || '').toLowerCase();
  if (loc.includes('remote')) return 'Remote';
  if (loc.includes('hybrid')) return 'Hybrid';
  return 'On-site'; // Default
}

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const files = [
      path.join(__dirname, '../Karachi_Internships_2026.xlsx'),
      path.join(__dirname, '../Karachi_Internships_2026 (1).xlsx')
    ];

    let allRows = [];

    for (const file of files) {
      console.log(`📖 Reading Excel file: ${path.basename(file)}...`);
      const workbook = XLSX.readFile(file);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);
      console.log(`   Found ${data.length} rows.`);
      allRows = allRows.concat(data);
    }

    console.log(`\n🔄 Processing ${allRows.length} total rows...`);

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const processedJobs = [];

    for (const row of allRows) {
      const title = row['Internship Title'] || row['Title'];
      const companyName = row['Company Name'] || row['Company'];
      const rawLocation = row['Location'] || 'Karachi';
      const applyLink = row['Apply Link'] || row['Link'] || '';

      if (!title || !companyName) {
        skippedCount++;
        continue;
      }

      // Deduplicate locally in this run
      const dupKey = `${companyName.toLowerCase().trim()}_${title.toLowerCase().trim()}_${applyLink.toLowerCase().trim()}`;
      if (processedJobs.includes(dupKey)) {
        skippedCount++;
        continue;
      }
      processedJobs.push(dupKey);

      // Map categories and location types
      const category = mapCategory(row['Category']);
      const locationType = mapLocationType(rawLocation);

      // Clean skills list
      const rawSkills = row['Key Skills Required'] || row['Skills'] || '';
      const skills = rawSkills
        .split(/[,,;]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      // Description formatting
      let description = row['Job Description Summary'] || row['Description'] || `Internship at ${companyName}`;
      if (row['Timing / Shift']) {
        description += `\n\nTiming / Shift: ${row['Timing / Shift']}`;
      }
      if (row['Link Type']) {
        description += `\n\nApplication Process: ${row['Link Type']}`;
      }

      // Prepare job structure matching Job.js model
      const jobData = {
        title: title.trim(),
        companyName: companyName.trim(),
        department: (row['Category'] || 'General').trim(),
        category,
        location: rawLocation.trim(),
        locationType,
        type: 'Internship',
        salary: (row['Estimated Salary / Stipend'] || 'Not Specified').trim(),
        email: 'hello@deftcrew.com',
        number:'03278260887', // Required by schema
        description: description.trim(),
        skills,
        requirements: skills.concat(row['Timing / Shift'] ? [`Timing: ${row['Timing / Shift']}`] : []),
        isExternal: true,
        externalUrl: applyLink.trim(),
        source: 'manual',
        active: true,
        applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) // 60 days from now
      };

      // Upsert to database
      const existingJob = await Job.findOne({
        title: jobData.title,
        companyName: jobData.companyName,
        type: 'Internship'
      });

      let savedJob;
      if (existingJob) {
        existingJob.department = jobData.department;
        existingJob.category = jobData.category;
        existingJob.location = jobData.location;
        existingJob.locationType = jobData.locationType;
        existingJob.salary = jobData.salary;
        existingJob.description = jobData.description;
        existingJob.skills = jobData.skills;
        existingJob.requirements = jobData.requirements;
        existingJob.externalUrl = jobData.externalUrl;
        existingJob.active = true;
        existingJob.updatedAt = Date.now();
        savedJob = await existingJob.save();
        updatedCount++;
      } else {
        const newJob = new Job(jobData);
        savedJob = await newJob.save();
        createdCount++;
      }

      // Generate job embeddings in the background (fire-and-forget style)
      if (savedJob && process.env.OPENAI_API_KEY) {
        setImmediate(() => generateJobEmbedding(savedJob._id.toString()));
      }
    }

    console.log('\n📊 Seeding Summary:');
    console.log(`   - Created: ${createdCount}`);
    console.log(`   - Updated: ${updatedCount}`);
    console.log(`   - Skipped/Deduplicated: ${skippedCount}`);
    console.log('\n✅ Internships database import successfully finished!');

  } catch (err) {
    console.error('❌ Excel import script failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

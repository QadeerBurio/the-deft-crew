// scripts/importCsvJobs.js
// ============================================================
// Script to import jobs and internships from:
// 1. ai_studio_code.csv
// 2. Karachi_Lahore_Islamabad_Jobs_Internships.csv
// into the Job collection with deduplication and embedding generation.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');
const Job = require('../models/Job');
const { generateJobEmbedding } = require('../services/jobEmbeddingService');

// Category mapping helper
function mapCategory(department, title) {
  const text = `${department || ''} ${title || ''}`.toLowerCase();
  if (text.includes('cs') || text.includes('software') || text.includes('it') || text.includes('tech') || text.includes('computer') || text.includes('web') || text.includes('developer') || text.includes('robotics') || text.includes('ai')) {
    return 'Technology';
  }
  if (text.includes('market') || text.includes('digital') || text.includes('social media') || text.includes('copywrit') || text.includes('media') || text.includes('adcom') || text.includes('brand')) {
    return 'Marketing';
  }
  if (text.includes('sale') || text.includes('business dev') || text.includes('call center')) {
    return 'Sales';
  }
  if (text.includes('finance') || text.includes('account') || text.includes('audit') || text.includes('tax') || text.includes('bank') || text.includes('banking') || text.includes('fintech')) {
    return 'Finance';
  }
  if (text.includes('hr') || text.includes('human') || text.includes('recruit') || text.includes('talent')) {
    return 'HR';
  }
  if (text.includes('design') || text.includes('graphics') || text.includes('ui') || text.includes('ux') || text.includes('creative') || text.includes('video') || text.includes('editing')) {
    return 'Design';
  }
  if (text.includes('operation') || text.includes('logistics') || text.includes('supply') || text.includes('admin') || text.includes('office') || text.includes('e-commerce') || text.includes('amazon') || text.includes('customer')) {
    return 'Operations';
  }
  return 'Other';
}

// Location type mapping helper
function mapLocationType(location) {
  const loc = (location || '').toLowerCase();
  if (loc.includes('remote')) return 'Remote';
  if (loc.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

// Job Type mapping helper
function mapJobType(rawType) {
  const typeStr = (rawType || '').toLowerCase();
  if (typeStr.includes('intern') || typeStr.includes('internship')) {
    return 'Internship';
  }
  if (typeStr.includes('contract')) {
    return 'Contract';
  }
  if (typeStr.includes('part-time') || typeStr.includes('part time')) {
    return 'Part-time';
  }
  if (typeStr.includes('temporary')) {
    return 'Temporary';
  }
  // Entry-Level, Management Trainee, Graduate Trainee, Full-Time defaults to Full-time
  return 'Full-time';
}

// Extract skill tags from title & department
function extractSkills(title, department, audience) {
  const text = `${title} ${department} ${audience}`.toLowerCase();
  const skillKeywords = [
    'Python', 'JavaScript', 'React', 'Node.js', 'Web Development', 'Full Stack',
    'AI', 'Data Analyst', 'Blockchain', 'Robotics', 'Finance', 'Taxation',
    'Accounting', 'Audit', 'Digital Marketing', 'Social Media', 'Copywriting',
    'Video Editing', 'Customer Support', 'Sales', 'E-commerce', 'Amazon',
    'Human Resources', 'Supply Chain', 'Media Planning', 'Software Engineering'
  ];
  
  const skills = [];
  skillKeywords.forEach(keyword => {
    if (text.includes(keyword.toLowerCase())) {
      skills.push(keyword);
    }
  });

  if (skills.length === 0) {
    if (department) skills.push(department.trim());
  }
  return [...new Set(skills)];
}

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const files = [
      path.join(__dirname, '../ai_studio_code.csv'),
      path.join(__dirname, '../Karachi_Lahore_Islamabad_Jobs_Internships.csv')
    ];

    let allRows = [];

    for (const file of files) {
      console.log(`📖 Reading CSV file: ${path.basename(file)}...`);
      const workbook = XLSX.readFile(file);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);
      console.log(`   Found ${data.length} rows.`);
      allRows = allRows.concat(data);
    }

    console.log(`\n🔄 Processing ${allRows.length} total rows from CSV files...`);

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const processedKeys = new Set();

    for (const row of allRows) {
      const companyName = row['Company'] || row['company'];
      const title = row['Job Title / Program'] || row['Title'] || row['Job Title'];
      const department = row['Department'] || 'General';
      const rawType = row['Job Type'] || 'Internship';
      const audience = row['Target Audience'] || '';
      const applyLink = row['Application Link / Method'] || row['Link'] || '';
      const location = row['Location'] || 'Pakistan';

      if (!title || !companyName) {
        skippedCount++;
        continue;
      }

      const dupKey = `${companyName.toLowerCase().trim()}_${title.toLowerCase().trim()}_${location.toLowerCase().trim()}`;
      if (processedKeys.has(dupKey)) {
        skippedCount++;
        continue;
      }
      processedKeys.add(dupKey);

      const category = mapCategory(department, title);
      const locationType = mapLocationType(location);
      const jobType = mapJobType(rawType);
      const skills = extractSkills(title, department, audience);

      let description = `${title} at ${companyName}.\n\nDepartment: ${department}`;
      if (audience) {
        description += `\nTarget Audience: ${audience}`;
      }
      if (rawType) {
        description += `\nOpportunity Type: ${rawType}`;
      }
      if (applyLink) {
        description += `\nApply URL: ${applyLink}`;
      }

      const jobData = {
        title: title.trim(),
        companyName: companyName.trim(),
        department: department.trim(),
        category,
        location: location.trim(),
        locationType,
        type: jobType,
        salary: 'Competitive',
        email: 'careers@deftcrew.com',
        description: description.trim(),
        skills,
        requirements: audience ? [audience.trim()] : ['Relevant qualification or experience'],
        isExternal: true,
        externalUrl: applyLink.trim(),
        source: 'manual',
        active: true,
        // Set deadline to 60 days from today
        applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
      };

      const existingJob = await Job.findOne({
        title: jobData.title,
        companyName: jobData.companyName,
        location: jobData.location
      });

      let savedJob;
      if (existingJob) {
        existingJob.department = jobData.department;
        existingJob.category = jobData.category;
        existingJob.locationType = jobData.locationType;
        existingJob.type = jobData.type;
        existingJob.description = jobData.description;
        existingJob.skills = jobData.skills;
        existingJob.requirements = jobData.requirements;
        existingJob.externalUrl = jobData.externalUrl;
        existingJob.active = true;
        existingJob.applicationDeadline = jobData.applicationDeadline;
        existingJob.updatedAt = Date.now();
        savedJob = await existingJob.save();
        updatedCount++;
      } else {
        const newJob = new Job(jobData);
        savedJob = await newJob.save();
        createdCount++;
      }

      // Generate job embedding in background
      if (savedJob && process.env.OPENAI_API_KEY) {
        setImmediate(() => generateJobEmbedding(savedJob._id.toString()));
      }
    }

    console.log('\n📊 CSV Import Summary:');
    console.log(`   - Created: ${createdCount}`);
    console.log(`   - Updated: ${updatedCount}`);
    console.log(`   - Skipped/Duplicates: ${skippedCount}`);
    console.log('\n✅ CSV Jobs & Internships import successfully completed!');

  } catch (err) {
    console.error('❌ CSV import script error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

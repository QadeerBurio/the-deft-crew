// services/jobs/csvJobImporter.js
// ============================================================
// Reusable Job CSV/XLSX Importer Service
// ============================================================
// Parses CSV and XLSX job/internship files, normalizes fields,
// checks MongoDB for existing jobs (updates if existing, creates if new),
// and triggers OpenAI embedding generation for saved jobs.
// ============================================================

const XLSX = require('xlsx');
const Job = require('../../models/Job');
const { generateJobEmbedding } = require('../jobEmbeddingService');

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

/**
 * Parses and imports jobs from a CSV or XLSX file path or Buffer.
 * Upserts matching jobs into MongoDB and triggers background vector embedding.
 * 
 * @param {string|Buffer} filePathOrBuffer - Path to .csv/.xlsx file OR File Buffer
 * @param {string} [originalFilename=''] - Optional original filename for file extension detection
 * @returns {Promise<{ created: number, updated: number, skipped: number }>} Counts summary
 */
async function importJobsFromFile(filePathOrBuffer, originalFilename = '') {
  let workbook;

  if (Buffer.isBuffer(filePathOrBuffer)) {
    workbook = XLSX.read(filePathOrBuffer, { type: 'buffer', cellDates: true });
  } else if (typeof filePathOrBuffer === 'string') {
    workbook = XLSX.readFile(filePathOrBuffer, { cellDates: true });
  } else {
    throw new Error('Invalid input: Expected file path string or Buffer.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { created: 0, updated: 0, skipped: 0 };
  }

  const worksheet = workbook.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const processedKeys = new Set();

  for (const row of allRows) {
    // Flexible column-name fallback matching
    const companyName = (
      row['Company'] || row['company'] || row['Company Name'] || row['company_name'] || ''
    ).toString().trim();

    const title = (
      row['Job Title / Program'] || row['Title'] || row['Job Title'] || 
      row['Internship Title'] || row['job_title'] || row['title'] || ''
    ).toString().trim();

    const department = (
      row['Department'] || row['department'] || 'General'
    ).toString().trim();

    const rawType = (
      row['Job Type'] || row['job_type'] || 'Internship'
    ).toString().trim();

    const audience = (
      row['Target Audience'] || row['target_audience'] || ''
    ).toString().trim();

    const applyLink = (
      row['Application Link / Method'] || row['Application Link'] || 
      row['Backup Search Link'] || row['Link'] || row['link'] || ''
    ).toString().trim();

    const location = (
      row['Location'] || row['location'] || 'Pakistan'
    ).toString().trim();

    // Required fields check
    if (!title || !companyName) {
      skippedCount++;
      continue;
    }

    // Deduplication check within current file loop
    const dupKey = `${companyName.toLowerCase()}_${title.toLowerCase()}_${location.toLowerCase()}`;
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
    if (audience) description += `\nTarget Audience: ${audience}`;
    if (rawType) description += `\nOpportunity Type: ${rawType}`;
    if (applyLink) description += `\nApply URL: ${applyLink}`;

    const jobData = {
      title,
      companyName,
      department,
      category,
      location,
      locationType,
      type: jobType,
      salary: 'Competitive',
      email: 'careers@deftcrew.com',
      description: description.trim(),
      skills,
      requirements: audience ? [audience] : ['Relevant qualification or experience'],
      isExternal: true,
      externalUrl: applyLink,
      source: 'manual',
      active: true,
      // Default application deadline set to 60 days from upload date
      applicationDeadline: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
    };

    // Database duplicate check (upsert matching title + companyName + location)
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

    // Trigger AI vector embedding generation if OpenAI API key is present
    if (savedJob && process.env.OPENAI_API_KEY) {
      setImmediate(() => generateJobEmbedding(savedJob._id.toString()));
    }
  }

  return {
    created: createdCount,
    updated: updatedCount,
    skipped: skippedCount
  };
}

module.exports = {
  importJobsFromFile,
  mapCategory,
  mapLocationType,
  mapJobType,
  extractSkills
};

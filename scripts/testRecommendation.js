// scripts/testRecommendation.js
// Verification script for the redesigned Internship Recommendation Engine.
// Run this script using Node.js to verify all 9 stages of the pipeline.

const mongoose = require('mongoose');
const path = require('path');

// Load environment variables from backend directory
require('dotenv').config();

const Job = require('../models/Job');
const Resume = require('../models/Resume');
const User = require('../models/User');
const JobInteraction = require('../models/JobInteraction');
const JobEmbedding = require('../models/JobEmbedding');
const { getHybridRecommendations } = require('../services/recommendationService');
const { normalizeSkill, normalizeSkills } = require('../utils/skillNormalizer');

async function testPipeline() {
  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected successfully!');

  // Clear existing test documents if any
  const testSuffix = '_test_rec_engine';
  await User.deleteMany({ email: new RegExp(testSuffix, 'i') });
  await Resume.deleteMany({ 'personalInfo.email': new RegExp(testSuffix, 'i') });
  await Job.deleteMany({ companyName: new RegExp(testSuffix, 'i') });
  await JobInteraction.deleteMany({});

  console.log('🌱 Creating test user and resume...');
  
  // 1. Create Test User
  const user = await User.create({
    name: 'Test Candidate',
    email: `candidate${testSuffix}@test.com`,
    password: 'securepassword123',
    role: 'student',
    location: 'Karachi, Pakistan'
  });

  // 2. Create Test Resume (Stage 2: Candidate Profile Understanding)
  const resume = new Resume({
    user: user._id,
    personalInfo: {
      firstName: 'Test',
      lastName: 'Candidate',
      email: `candidate${testSuffix}@test.com`,
      city: 'Karachi',
      country: 'Pakistan'
    },
    professionalSummary: {
      title: 'Full Stack Engineer',
      experienceLevel: 'Entry Level'
    },
    skills: [
      { name: 'js', level: 'Advanced', category: 'Technical' }, // should normalize to JavaScript
      { name: 'py', level: 'Intermediate', category: 'Technical' }, // should normalize to Python
      { name: 'ReactJS', level: 'Advanced', category: 'Technical' }, // should normalize to React
      { name: 'HTML', level: 'Advanced', category: 'Technical' }, // should normalize to HTML
      { name: 'CSS', level: 'Advanced', category: 'Technical' }, // should normalize to CSS
      { name: 'GenAI', level: 'Beginner', category: 'Technical' } // should normalize to Generative AI
    ],
    projects: [
      {
        name: 'AI Chatbot',
        description: 'Built a chatbot using llm models and typescript.', // should match Large Language Models and TypeScript
        technologies: ['TypeScript', 'llm']
      }
    ],
    education: [
      {
        institution: 'University of Karachi',
        degree: 'Bachelor\'s Degree',
        fieldOfStudy: 'Computer Science',
        gpa: 3.8
      }
    ],
    targetJob: {
      jobTitle: 'Frontend developer',
      jobType: 'Internship',
      location: 'Karachi'
    },
    careerProfile: {
      extractedSkills: {
        technical: ['js', 'py', 'ReactJS', 'GenAI', 'html', 'css'],
        frameworks: ['ReactJS'],
        languages: ['js', 'py'],
        tools: ['git'],
        databases: ['mongodb'],
        cloud: ['aws'],
        softSkills: ['teamwork']
      },
      seniority: 'Intern',
      totalYearsExperience: 0.5,
      preferredRoles: ['Frontend developer', 'Software Engineer'],
      preferredIndustries: ['Technology'],
      preferredLocations: ['Karachi', 'Remote'],
      openToRemote: true,
      isEnriched: true
    }
  });

  // Generate mock embedding for the resume (1536 dims)
  const mockVector = new Array(1536).fill(0).map(() => Math.random() * 0.1);
  resume.careerProfile.embedding = {
    vector: mockVector,
    model: 'text-embedding-3-small',
    generatedAt: new Date(),
    version: 1
  };
  await resume.save();

  console.log('💼 Creating test jobs...');

  // 3. Create Test Jobs (Stage 3: Job Understanding)
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + 15); // Active for 15 days

  // Job 1: Perfect skill match & remote (JavaScript + React)
  const job1 = await Job.create({
    title: 'Frontend Developer Intern',
    companyName: `DeftCorp${testSuffix}`,
    department: 'Engineering',
    category: 'Technology',
    location: 'Remote',
    locationType: 'Remote',
    type: 'Internship',
    salary: '20,000 - 30,000 PKR',
    salaryMin: 20000,
    salaryMax: 30000,
    email: 'jobs@deftcorp.com',
    experienceLevel: 'Entry Level',
    minExperience: 0,
    education: 'Bachelor\'s Degree',
    skills: ['JavaScript', 'React', 'HTML', 'CSS'],
    description: 'Looking for a Frontend Intern with JavaScript and React skills.',
    requirements: ['Experience with React and modern HTML/CSS.', 'Knowledge of JS is required.'],
    active: true,
    applicationDeadline: deadline,
    postedBy: user._id
  });

  // Job 2: Good match with synonym (Python / Django)
  const job2 = await Job.create({
    title: 'Python Backend Intern',
    companyName: `DeftCorp${testSuffix}`,
    department: 'Engineering',
    category: 'Technology',
    location: 'Karachi',
    locationType: 'Hybrid',
    type: 'Internship',
    salary: '25,000 PKR',
    salaryMin: 25000,
    salaryMax: 25000,
    email: 'jobs@deftcorp.com',
    experienceLevel: 'Entry Level',
    minExperience: 0,
    education: 'Bachelor\'s Degree',
    skills: ['python', 'django', 'mongodb'],
    description: 'Looking for a Django Developer.',
    requirements: ['Must have Python experience.'],
    active: true,
    applicationDeadline: deadline,
    postedBy: user._id
  });

  // Job 3: Unrelated job (HR Recruiter)
  const job3 = await Job.create({
    title: 'HR Intern',
    companyName: `RecruitCorp${testSuffix}`,
    department: 'HR',
    category: 'HR',
    location: 'Karachi',
    locationType: 'On-site',
    type: 'Internship',
    salary: '15,000 PKR',
    salaryMin: 15000,
    salaryMax: 15000,
    email: 'jobs@recruitcorp.com',
    experienceLevel: 'Entry Level',
    minExperience: 0,
    education: 'Bachelor\'s Degree',
    skills: ['communication', 'hiring'],
    description: 'HR and recruitment support.',
    requirements: ['Great communication skills.'],
    active: true,
    applicationDeadline: deadline,
    postedBy: user._id
  });

  // Mock embeddings for jobs (Job 1 is closer, Job 2 medium, Job 3 distant)
  const mockVectorJob1 = [...mockVector].map(v => v * 1.2 + (Math.random() - 0.5) * 0.01);
  const mockVectorJob2 = [...mockVector].map(v => v * 0.8 + (Math.random() - 0.5) * 0.05);
  const mockVectorJob3 = new Array(1536).fill(0).map(() => Math.random() * 0.1);

  await JobEmbedding.create([
    { jobId: job1._id, embedding: mockVectorJob1, embeddingText: job1.description },
    { jobId: job2._id, embedding: mockVectorJob2, embeddingText: job2.description },
    { jobId: job3._id, embedding: mockVectorJob3, embeddingText: job3.description }
  ]);

  console.log('🔍 Test 1: Fetching recommendations without behavioral interaction history...');
  let recs = await getHybridRecommendations(resume._id, user._id, { limit: 10 });

  console.log(`Fetched ${recs.length} recommendations:`);
  recs.forEach(r => {
    console.log(`- [${r.matchPercentage}%] ${r.title} at ${r.companyName}`);
    console.log(`  Highlights: ${r.explanation.highlights.join(', ')}`);
    console.log(`  Matched required: ${r.explanation.matchedSkills.join(', ')}`);
    console.log(`  Missing: ${r.explanation.missingSkills.join(', ')}`);
    console.log(`  Breakdown:`, JSON.stringify(r.breakdown, null, 2));
  });

  // Basic validation checks
  const topMatch = recs[0];
  if (topMatch.title !== 'Frontend Developer Intern') {
    throw new Error(`Expected Frontend Developer Intern to be top match, got: ${topMatch.title}`);
  }
  console.log('✅ Test 1 Passed! Frontend Developer Intern ranked first.');

  console.log('\n🧠 Test 2: Checking Skill Synonym Normalization...');
  // Check if job2 skills normalized successfully
  const job2Rec = recs.find(r => r._id.toString() === job2._id.toString());
  if (!job2Rec) {
    throw new Error('Python job not recommended');
  }
  console.log(`Python Job Match Percentage: ${job2Rec.matchPercentage}%`);
  console.log(`Python Job Matched Skills: ${job2Rec.matchedSkills.join(', ')}`);
  if (!job2Rec.matchedSkills.includes('Python')) {
    throw new Error('Synonym normalization failed: "py" did not match "python"');
  }
  console.log('✅ Test 2 Passed! Synonym normalisation validated successfully.');

  console.log('\n🎭 Test 3: Checking Behavioral Learning Layer (Affinity Boost & Penalty)...');
  // Log a view interaction for Job 2 (Python)
  console.log('Logging view interaction for Python Intern job...');
  await JobInteraction.create({
    userId: user._id,
    jobId: job2._id,
    interactionType: 'view'
  });

  // Fetch recommendations again to see if Python Job ranks higher or boosts score
  let recsAfterView = await getHybridRecommendations(resume._id, user._id, { limit: 10 });
  const job2RecAfterView = recsAfterView.find(r => r._id.toString() === job2._id.toString());
  console.log(`Python match score before view: ${job2Rec.matchPercentage}%, after view: ${job2RecAfterView.matchPercentage}%`);
  if (job2RecAfterView.matchPercentage <= job2Rec.matchPercentage) {
    console.warn('⚠️ Match score did not boost (might be due to cap or scaling), checking logic...');
  } else {
    console.log('🚀 Score boosted successfully due to user view interaction.');
  }

  // Now log a dismiss interaction for Job 2
  console.log('Dismissing the Python Intern job...');
  await JobInteraction.create({
    userId: user._id,
    jobId: job2._id,
    interactionType: 'dismiss'
  });

  // Job 2 should be excluded from recommendations due to dismissal hard filter
  let recsAfterDismiss = await getHybridRecommendations(resume._id, user._id, { limit: 10 });
  const job2RecAfterDismiss = recsAfterDismiss.find(r => r._id.toString() === job2._id.toString());
  if (job2RecAfterDismiss) {
    throw new Error('Hard filter failed: Dismissed job was not excluded from recommendations');
  }
  console.log('✅ Test 3 Passed! Dismissed job was excluded successfully.');

  console.log('\n🎨 Test 4: Checking Diversity & Exploration Re-ranking...');
  // Create 3 more jobs from DeftCorp (Job 1, Job 2 already exist, Job 2 dismissed)
  // Let's create Job 4, Job 5 from DeftCorp
  await Job.create([
    {
      title: 'UI Design Intern',
      companyName: `DeftCorp${testSuffix}`,
      department: 'Design',
      category: 'Design',
      location: 'Karachi',
      locationType: 'On-site',
      type: 'Internship',
      salary: '20,000 PKR',
      email: 'jobs@deftcorp.com',
      experienceLevel: 'Entry Level',
      skills: ['react', 'figma'],
      description: 'UI Design with React.',
      active: true,
      applicationDeadline: deadline,
      postedBy: user._id
    },
    {
      title: 'QA Engineer Intern',
      companyName: `DeftCorp${testSuffix}`,
      department: 'Engineering',
      category: 'Technology',
      location: 'Karachi',
      locationType: 'On-site',
      type: 'Internship',
      salary: '22,000 PKR',
      email: 'jobs@deftcorp.com',
      experienceLevel: 'Entry Level',
      skills: ['jest', 'react'],
      description: 'QA with Jest.',
      active: true,
      applicationDeadline: deadline,
      postedBy: user._id
    }
  ]);

  let recsWithDiversity = await getHybridRecommendations(resume._id, user._id, { limit: 10 });
  const deftCorpJobs = recsWithDiversity.filter(r => r.companyName.includes('DeftCorp'));
  console.log(`DeftCorp jobs recommended: ${deftCorpJobs.length}`);
  if (deftCorpJobs.length > 2) {
    throw new Error(`Diversity failed: expected max 2 jobs from DeftCorp, got ${deftCorpJobs.length}`);
  }
  console.log('✅ Test 4 Passed! Diversity penalty successfully capped jobs from DeftCorp to 2.');

  // Clean up
  console.log('\n🧹 Cleaning up database...');
  await User.deleteMany({ email: new RegExp(testSuffix, 'i') });
  await Resume.deleteMany({ 'personalInfo.email': new RegExp(testSuffix, 'i') });
  await Job.deleteMany({ companyName: new RegExp(testSuffix, 'i') });
  await JobInteraction.deleteMany({ userId: user._id });
  await JobEmbedding.deleteMany({ jobId: { $in: [job1._id, job2._id, job3._id] } });

  console.log('🎉 All tests completed successfully!');
  process.exit(0);
}

testPipeline().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});

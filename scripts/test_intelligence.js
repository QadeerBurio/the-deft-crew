const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Resume = require('../models/Resume');
const { optimizeParsedResume } = require('../services/resumeIntelligenceService');

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find any resume that has some work experience or skills
    const resume = await Resume.findOne({ 
      $or: [
        { 'workExperience.0': { $exists: true } },
        { 'skills.0': { $exists: true } }
      ]
    }).lean();

    if (!resume) {
      console.log('No resumes with experience/skills found in DB to test.');
      return;
    }

    console.log(`Found Test Resume ID: ${resume._id} for User: ${resume.user}`);
    console.log('Candidate Name:', resume.personalInfo?.firstName, resume.personalInfo?.lastName || '');
    console.log('Original Summary:', resume.professionalSummary?.summary || 'None');
    console.log(`Original Work History: ${resume.workExperience?.length || 0} items`);
    console.log(`Original Projects: ${resume.projects?.length || 0} items`);
    console.log(`Original Skills: ${resume.skills?.length || 0} items\n`);

    console.log('🚀 Running AI Resume Intelligence Engine on this resume...');
    const startTime = Date.now();
    const optimized = await optimizeParsedResume(resume);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Optimization completed in ${duration}s!\n`);

    // Verify all requested fields are present
    const fields = [
      'careerLevel', 'industry', 'targetRole', 'professionalBrand',
      'personalBranding', 'careerHighlights', 'coreCompetencies', 'atsKeywords',
      'missingKeywords', 'keywordMatchPercentage', 'resumeScores', 'hrScorecard',
      'hiringDecision', 'industryBenchmarking', 'prioritizedImprovementPlan',
      'missingSkills', 'strengths', 'weaknesses', 'optimizedSummary',
      'optimizedExperience', 'optimizedProjects', 'optimizedSkills', 'hrRecommendations'
    ];

    console.log('📊 Verification of Output Fields:');
    fields.forEach(field => {
      const exists = optimized[field] !== undefined;
      const lengthInfo = Array.isArray(optimized[field]) ? `(array size: ${optimized[field].length})` : typeof optimized[field] === 'object' ? `(object keys: ${Object.keys(optimized[field] || {}).join(',')})` : '';
      console.log(`   - ${field}: ${exists ? '✅ Present' : '❌ Missing'} ${lengthInfo}`);
    });

    console.log('\n--- DETECTED METADATA ---');
    console.log('Industry:', optimized.industry);
    console.log('Career Level:', optimized.careerLevel);
    console.log('Target Role:', optimized.targetRole);
    console.log('Professional Brand:', optimized.professionalBrand);
    console.log('Personal Branding:', JSON.stringify(optimized.personalBranding, null, 2));
    console.log('Core Competencies:', (optimized.coreCompetencies || []).join(', '));
    console.log('ATS Keywords:', (optimized.atsKeywords || []).join(', '));
    console.log('Missing Keywords:', (optimized.missingKeywords || []).join(', '));
    console.log('Keyword Match Percentage:', optimized.keywordMatchPercentage + '%');

    console.log('\n--- RESUME SCORES ---');
    console.log(JSON.stringify(optimized.resumeScores, null, 2));

    console.log('\n--- HR SCORECARD ---');
    console.log(JSON.stringify(optimized.hrScorecard, null, 2));

    console.log('\n--- HIRING DECISION ---');
    console.log(JSON.stringify(optimized.hiringDecision, null, 2));

    console.log('\n--- INDUSTRY BENCHMARKING ---');
    console.log(JSON.stringify(optimized.industryBenchmarking, null, 2));

    console.log('\n--- PRIORITIZED IMPROVEMENT PLAN ---');
    console.log(JSON.stringify(optimized.prioritizedImprovementPlan, null, 2));

    console.log('\n--- MISSING SKILLS ---');
    console.log((optimized.missingSkills || []).join(', '));

    console.log('\n--- STRENGTHS & WEAKNESSES ---');
    console.log('Strengths:', (optimized.strengths || []).join(' | '));
    console.log('Weaknesses:', (optimized.weaknesses || []).join(' | '));

    console.log('\n--- OPTIMIZED SUMMARY ---');
    console.log(optimized.optimizedSummary);

    console.log('\n--- OPTIMIZED EXPERIENCE (First 1 rewritten) ---');
    if (optimized.optimizedExperience && optimized.optimizedExperience.length > 0) {
      console.log('Company:', optimized.optimizedExperience[0].company);
      console.log('Position:', optimized.optimizedExperience[0].position);
      console.log('Rewritten Description:\n', optimized.optimizedExperience[0].description);
    } else {
      console.log('No experience items returned.');
    }

    console.log('\n--- HR RECOMMENDATIONS ---');
    (optimized.hrRecommendations || []).forEach((rec, idx) => {
      console.log(`   ${idx + 1}. ${rec}`);
    });

  } catch (err) {
    console.error('❌ Script failed:', err.stack || err.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

// scripts/verifyProductionRecommendations.js
// Production verification script for the redesigned Hybrid Recommendation Engine.
// It loads a real resume from MongoDB, runs recommendation against the real internships dataset,
// ranks them, and outputs the top 10 recommendations with detailed explanations and breakdowns.

const mongoose = require('mongoose');
require('dotenv').config();

const Resume = require('../models/Resume');
const Job = require('../models/Job');
const User = require('../models/User');
const { getHybridRecommendations } = require('../services/recommendationService');

async function main() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected successfully!');

    // 1. Fetch a real resume from the database (prefer enriched target)
    console.log('\n🔎 Querying for a real resume in MongoDB...');
    let resume = await Resume.findOne({ _id: '6a4d3b82e588678641fb88be' }).select('_id user skills professionalSummary targetJob careerProfile').lean();
    if (!resume) {
      resume = await Resume.findOne({ 'careerProfile.isEnriched': true }).select('_id user skills professionalSummary targetJob careerProfile').lean();
    }
    if (!resume) {
      resume = await Resume.findOne().select('_id user skills professionalSummary targetJob careerProfile').lean();
    }
    
    if (!resume) {
      console.warn('⚠️ No resumes found in MongoDB! Please create/upload a resume first.');
      process.exit(1);
    }

    // Resolve user details
    const user = await User.findById(resume.user).select('name email').lean();
    const userName = user ? user.name : 'Unknown User';
    
    console.log('================================================================');
    console.log(`👤 Selected Resume ID: ${resume._id}`);
    console.log(`   Candidate Name:    ${userName}`);
    console.log(`   Professional Title:${resume.professionalSummary?.title || 'Not Specified'}`);
    console.log(`   Skills Listed:     ${(resume.skills || []).map(s => s.name || s).join(', ') || 'None'}`);
    console.log(`   Target Job Title:  ${resume.targetJob?.jobTitle || 'Not Specified'}`);
    console.log('================================================================\n');

    // 2. Fetch the internships imported from the Excel files to verify data exists
    const totalInternshipsCount = await Job.countDocuments({ type: 'Internship', isExternal: true });
    console.log(`📊 Real internships currently in MongoDB: ${totalInternshipsCount}`);
    if (totalInternshipsCount === 0) {
      console.warn('⚠️ No internships found in MongoDB. Make sure to run `node scripts/importExcelInternships.js` first.');
      process.exit(1);
    }

    // 3. Run Recommendation Engine against the real database (exclusive Karachi_Internships_2026 data source)
    console.log('🎯 Running Hybrid Recommendation Engine...');
    const recommendations = await getHybridRecommendations(resume._id, resume.user, {
      limit: 10,
      isExternal: true // Fetch imported Excel internships
    });

    console.log(`✨ Recommendation Engine returned ${recommendations.length} recommendations.\n`);

    if (recommendations.length === 0) {
      console.log('🔍 No matching recommendations found for this resume. Relaxing filters...');
      // Fetch recommendations without isExternal flag (which returns all internships)
      const recommendationsRelaxed = await getHybridRecommendations(resume._id, resume.user, { limit: 10 });
      console.log(`✨ Relaxed search returned ${recommendationsRelaxed.length} recommendations.`);
      printRecs(recommendationsRelaxed);
    } else {
      printRecs(recommendations);
    }

  } catch (err) {
    console.error('❌ Verification failed:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB.');
    process.exit(0);
  }
}

function printRecs(recs) {
  recs.forEach((rec, idx) => {
    console.log(`----------------------------------------------------------------`);
    console.log(`${idx + 1}. [${rec.matchPercentage}% Match] ${rec.title}`);
    console.log(`   Company:      ${rec.companyName}`);
    console.log(`   Location:     ${rec.location} (${rec.locationType})`);
    console.log(`   Stipend:      ${rec.salary}`);
    
    const exp = rec.explanation;
    console.log(`\n   Matched Skills:`);
    if (exp.matchedSkills && exp.matchedSkills.length > 0) {
      exp.matchedSkills.forEach(s => console.log(`     ✔ ${s}`));
    } else {
      console.log(`     (None matched)`);
    }

    if (exp.matchedProjects && exp.matchedProjects.length > 0) {
      console.log(`   Matched Projects:`);
      exp.matchedProjects.forEach(p => console.log(`     ✔ ${p}`));
    }

    if (exp.matchedExperience && exp.matchedExperience.length > 0) {
      console.log(`   Matched Experience:`);
      exp.matchedExperience.forEach(e => console.log(`     ✔ ${e}`));
    }

    if (exp.matchedEducation && exp.matchedEducation.length > 0) {
      console.log(`   Matched Education:`);
      exp.matchedEducation.forEach(edu => console.log(`     ✔ ${edu}`));
    }

    if (exp.matchedLocation && exp.matchedLocation.length > 0) {
      console.log(`   Matched Location:`);
      exp.matchedLocation.forEach(loc => console.log(`     ✔ ${loc}`));
    }

    console.log(`   Missing Required Skills:`);
    if (exp.missingSkills && exp.missingSkills.length > 0) {
      exp.missingSkills.forEach(s => console.log(`     ✖ ${s}`));
    } else {
      console.log(`     (None missing)`);
    }

    console.log(`\n   Raw Score Breakdown:`);
    Object.entries(rec.breakdown || {}).forEach(([signal, val]) => {
      console.log(`     - ${signal.padEnd(25)}: ${Math.round(val * 100)}%`);
    });
  });
}

main();

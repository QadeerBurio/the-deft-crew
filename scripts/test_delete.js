const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Resume = require('../models/Resume');

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find any resume
    const resume = await Resume.findOne();
    if (!resume) {
      console.log('No resumes found to delete.');
      return;
    }

    console.log(`Found Resume ID: ${resume._id} for User: ${resume.user}`);
    console.log('Attempting deletion using Resume.findByIdAndDelete...');
    
    const deleted = await Resume.findByIdAndDelete(resume._id);
    console.log('Result of findByIdAndDelete:', deleted ? 'Success' : 'Failed');

    const check = await Resume.findById(resume._id);
    if (!check) {
      console.log('Verified: Resume is completely removed from DB.');
    } else {
      console.log('Error: Resume still exists in DB.');
    }

  } catch (err) {
    console.error('❌ Test failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

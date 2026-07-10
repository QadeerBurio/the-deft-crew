const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Resume = require('../models/Resume');
const User = require('../models/User');

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const resumes = await Resume.find().lean();
    console.log(`Total Resumes in DB: ${resumes.length}\n`);

    const userMap = {};
    for (const r of resumes) {
      if (!userMap[r.user]) {
        const u = await User.findById(r.user).lean();
        userMap[r.user] = u || { name: 'Unknown User' };
      }
      const u = userMap[r.user];
      console.log(`Resume ID: ${r._id} | User: ${u.name || u.email || r.user} (ID: ${r.user}) | Template: ${r.template} | Date: ${r.createdAt}`);
    }

    // Print users with their resume count
    console.log('\n--- Resume counts per user ---');
    const counts = {};
    for (const r of resumes) {
      counts[r.user] = (counts[r.user] || 0) + 1;
    }
    for (const userId in counts) {
      const u = userMap[userId];
      console.log(`User: ${u.name || u.email || userId} (ID: ${userId}) - Count: ${counts[userId]}`);
    }

  } catch (err) {
    console.error('❌ Script failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

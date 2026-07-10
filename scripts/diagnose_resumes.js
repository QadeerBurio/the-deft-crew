const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Resume = require('../models/Resume');
const User = require('../models/User');

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const users = await User.find({}).lean();
    console.log('--- USERS IN SYSTEM ---');
    for (const u of users) {
      const count = await Resume.countDocuments({ user: u._id });
      console.log(`User: ${u.name} (ID: ${u._id}) - Email: ${u.email} - Resumes Count: ${count}`);
      const userResumes = await Resume.find({ user: u._id }).lean();
      userResumes.forEach((r, idx) => {
        console.log(`   [${idx + 1}] Resume ID: ${r._id} - Title: ${r.professionalSummary?.title} - Updated: ${r.updatedAt}`);
      });
    }
    const undefinedCount = await Resume.countDocuments({ user: { $exists: false } });
    const nullCount = await Resume.countDocuments({ user: null });
    console.log(`\nResumes with user missing: ${undefinedCount}`);
    console.log(`Resumes with user null: ${nullCount}`);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}
main();

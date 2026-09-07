require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const { importEventsToDatabase } = require('./services/events/csvImporter');
const { Event } = require('./models/Event');

const xlsxPath = path.join(__dirname, 'Ticketwala_Karachi_Events.xlsx');

async function runTest() {
  console.log('🚀 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB.');

  // Clean up previous test events from CSV source to ensure clean baseline test
  await Event.deleteMany({ source: 'csv' });
  console.log('🧹 Cleaned up existing CSV events from DB for clean baseline.\n');

  console.log('▶️ Run 1: Importing Ticketwala_Karachi_Events.xlsx into DB...');
  const run1 = await importEventsToDatabase(xlsxPath);
  console.log(`   Run 1 Results: Total = ${run1.total}, Added = ${run1.added}, Skipped = ${run1.skipped}\n`);

  console.log('▶️ Run 2: Immediately re-importing same file (Duplicate-Skip Test)...');
  const run2 = await importEventsToDatabase(xlsxPath);
  console.log(`   Run 2 Results: Total = ${run2.total}, Added = ${run2.added}, Skipped = ${run2.skipped}\n`);

  // Query database directly
  const totalCsvEventsInDb = await Event.countDocuments({ source: 'csv' });
  console.log(`🔍 Direct DB Query Count (source: 'csv'): ${totalCsvEventsInDb}`);

  if (totalCsvEventsInDb === run1.total && run2.added === 0 && run2.skipped === run1.total) {
    console.log('\n🎉 SUCCESS: All events imported in Run 1, 0 added and 100% skipped in Run 2. DB count is exactly 64!');
  } else {
    console.warn(`\n⚠️ WARNING: DB count mismatch or duplicate prevention failed.`);
  }

  await mongoose.disconnect();
  console.log('👋 Disconnected from MongoDB.');
}

runTest().catch(err => {
  console.error('❌ Test failed with error:', err);
  mongoose.disconnect();
});

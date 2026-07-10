// scripts/testIngestion.js
require('dotenv').config();

const mongoose = require('mongoose');
const jobIngestionService = require('../services/jobIngestionService');

async function test() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected.');

    console.log('\n🚀 Triggering job ingestion pipeline...');
    const stats = await jobIngestionService.ingestJobs();

    console.log('\n📊 Ingestion Results:');
    console.log(JSON.stringify(stats, null, 2));

  } catch (err) {
    console.error('❌ Ingestion test failed:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

test();

// scripts/batchEmbedJobs.js
// ============================================================
// One-time batch script to generate embeddings for all existing jobs.
// Run ONCE from the Backend directory:
//   node scripts/batchEmbedJobs.js
//
// After this, all NEW/UPDATED jobs get embedded automatically via
// the fire-and-forget trigger in jobs.routes.js.
// ============================================================

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const { batchEmbedAllJobs } = require('../services/jobEmbeddingService');

async function main() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    console.log('🚀 Starting batch job embedding pipeline...');
    console.log('   Model:', process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small');
    console.log('   Batch size: 10 jobs, 500ms delay between batches\n');

    const { processed, total } = await batchEmbedAllJobs(10, 500);

    console.log(`\n✅ Done! Embedded ${processed}/${total} jobs.`);
  } catch (err) {
    console.error('❌ Batch embedding failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('🔗 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

// services/jobEmbeddingService.js
// ============================================================
// Generates and stores OpenAI embeddings for Job documents.
// Called fire-and-forget after every job create/update.
//
// Design notes:
//   - Embeddings stored in the separate `JobEmbedding` collection (Phase 0)
//   - The `embedding` field is select:false, so it never bloats job list APIs
//   - Cluster is M0 (free), so Atlas $vectorSearch is unavailable.
//     The recommendation engine fetches embeddings in a bounded cursor
//     (max 500 active jobs) rather than loading all of MongoDB into RAM.
// ============================================================

const OpenAI     = require('openai');
const JobEmbedding = require('../models/JobEmbedding');

let openai;
function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

// ── Build a rich text representation of a job for embedding ─────────────────
function buildJobText(job) {
  const parts = [];

  if (job.title)       parts.push(`Job Title: ${job.title}`);
  if (job.department)  parts.push(`Department: ${job.department}`);
  if (job.category)    parts.push(`Category: ${job.category}`);
  if (job.companyName) parts.push(`Company: ${job.companyName}`);
  if (job.location)    parts.push(`Location: ${job.location}`);
  if (job.locationType) parts.push(`Work Type: ${job.locationType}`);
  if (job.type)        parts.push(`Employment: ${job.type}`);
  if (job.experienceLevel) parts.push(`Experience: ${job.experienceLevel}`);
  if (job.education)   parts.push(`Education: ${job.education}`);

  if (job.skills?.length) {
    parts.push(`Required Skills: ${job.skills.join(', ')}`);
  }

  if (job.description) {
    // Truncate long descriptions — 800 chars is plenty for semantic meaning
    parts.push(`Description: ${job.description.slice(0, 800)}`);
  }

  if (job.requirements?.length) {
    parts.push(`Requirements: ${job.requirements.slice(0, 5).join('; ')}`);
  }

  if (job.responsibilities?.length) {
    parts.push(`Responsibilities: ${job.responsibilities.slice(0, 5).join('; ')}`);
  }

  return parts.join('\n');
}

// ── MAIN: Generate and upsert embedding for a single job ────────────────────
async function generateJobEmbedding(jobId) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  OPENAI_API_KEY not set — skipping job embedding');
    return;
  }

  try {
    const Job = require('../models/Job');
    const job = await Job.findById(jobId);
    if (!job || !job.active) return;

    const text = buildJobText(job);
    if (text.length < 30) {
      console.warn(`⚠️  [JobEmbedding] Job ${jobId} has insufficient text, skipping`);
      return;
    }

    const crypto = require('crypto');
    const textHash = crypto.createHash('sha256').update(text).digest('hex');

    // Skip if unchanged and valid embedding exists
    const existing = await JobEmbedding.findOne({ jobId }).select('+embedding textHash');
    if (existing && existing.textHash === textHash && existing.embedding && existing.embedding.length > 0) {
      // Content unchanged, skip log for clean terminal
      return existing.embedding;
    }

    const client = getOpenAI();
    const response = await client.embeddings.create({
      model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      input: text.slice(0, 8000)
    });

    const vector = response.data[0].embedding;

    // Upsert into JobEmbedding collection
    await JobEmbedding.findOneAndUpdate(
      { jobId },
      {
        jobId,
        embedding: vector,
        embeddingText: text.slice(0, 500), // Store preview for debugging
        textHash,
        model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        modelVersion: 1,
        generatedAt: new Date()
      },
      { upsert: true, new: true, runValidators: false }
    );

    // Embedded successfully, skip verbose log for clean terminal
    return vector;

  } catch (err) {
    console.error(`❌ [JobEmbedding] Error embedding job ${jobId}: ${err.message}`);
    return null;
  }
}

// ── Batch embed all jobs that don't have embeddings yet ──────────────────────
// Run this once manually via: node scripts/batchEmbedJobs.js
async function batchEmbedAllJobs(batchSize = 10, delayMs = 500) {
  const Job = require('../models/Job');

  // Find all active jobs that have no embedding yet
  const allJobIds = await Job.find({ active: true }).select('_id').lean();
  const embeddedIds = new Set(
    (await JobEmbedding.find().select('jobId').lean()).map(e => e.jobId.toString())
  );

  const missing = allJobIds
    .map(j => j._id.toString())
    .filter(id => !embeddedIds.has(id));

  console.log(`📊 [BatchEmbed] ${allJobIds.length} active jobs, ${embeddedIds.size} embedded, ${missing.length} to process`);

  let processed = 0;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    await Promise.all(batch.map(id => generateJobEmbedding(id)));
    processed += batch.length;
    console.log(`📊 [BatchEmbed] Progress: ${processed}/${missing.length}`);
    if (i + batchSize < missing.length && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`✅ [BatchEmbed] Completed. ${processed} jobs embedded.`);
  return { processed, total: missing.length };
}

module.exports = { generateJobEmbedding, batchEmbedAllJobs, buildJobText };

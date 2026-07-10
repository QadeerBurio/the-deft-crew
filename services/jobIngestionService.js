// services/jobIngestionService.js
// ============================================================
// Real-Time Job Ingestion Service (Decoupled Adapter Registry)
// ============================================================
// Orchestrates job imports from active connectors, runs
// deduplication checks, normalises fields, and spawns
// embedding vectors in a background thread.
// ============================================================

const Job = require('../models/Job');
const { generateJobEmbedding } = require('./jobEmbeddingService');
const { adapters } = require('./ingestion/registry');

class JobIngestionService {
  constructor() {
    this.adapters = adapters;
  }

  /**
   * Run ingestion from all available adapters registered in the registry
   * @returns {Promise<Object>} Ingestion statistics
   */
  async ingestJobs() {
    console.log('🚀 [Ingestion] Starting job ingestion workflow...');
    let totalFetched = 0;
    let totalSaved = 0;
    let totalUpdated = 0;
    const errors = [];

    // Repair existing jobs missing applicationDeadline
    try {
      const defaultDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const repairResult = await Job.updateMany(
        { applicationDeadline: { $exists: false } },
        { $set: { applicationDeadline: defaultDeadline } }
      );
      if (repairResult.modifiedCount > 0) {
        console.log(`⏰ [Ingestion] Repaired ${repairResult.modifiedCount} jobs with missing applicationDeadlines.`);
      }
    } catch (err) {
      console.error('⚠️  [Ingestion] Failed to run applicationDeadline repair:', err.message);
    }

    // Balance database by capping excess jobs from any single company (e.g. SpaceX) to 40
    try {
      const spaceXJobs = await Job.find({ companyName: 'SpaceX' }).sort({ createdAt: -1 });
      if (spaceXJobs.length > 40) {
        const toKeep = spaceXJobs.slice(0, 40).map(j => j._id);
        const cleanupResult = await Job.deleteMany({
          companyName: 'SpaceX',
          _id: { $nin: toKeep }
        });
        if (cleanupResult.deletedCount > 0) {
          console.log(`⏰ [Ingestion] Cleaned up ${cleanupResult.deletedCount} excess SpaceX jobs to restore feed balance.`);
        }
      }
    } catch (err) {
      console.error('⚠️  [Ingestion] Failed to run company balance cleanup:', err.message);
    }

    for (const adapter of this.adapters) {
      try {
        const jobs = await adapter.fetchJobs();
        totalFetched += jobs.length;

        const externalIds = jobs.map(j => j.externalId).filter(Boolean);
        const existingJobs = await Job.find({
          source: adapter.name,
          externalId: { $in: externalIds }
        });
        const existingJobsMap = new Map(existingJobs.map(j => [j.externalId, j]));

        const bulkOps = [];

        for (const jobData of jobs) {
          // Strictly restrict to Pakistan
          const location = (jobData.location || '').toLowerCase();
          const isPakistan = /pakistan|karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|gujranwala|hyderabad|abbottabad|sargodha|bahawalpur|sukkur|larkana|gujrat|sheikhupura|jhelum|sahiwal|pk/i.test(location);
          if (!isPakistan) {
            continue; // Discard any non-Pakistan jobs
          }

          const existingJob = existingJobsMap.get(jobData.externalId);

          if (existingJob) {
            bulkOps.push({
              updateOne: {
                filter: { _id: existingJob._id },
                update: {
                  $set: {
                    title: jobData.title,
                    salary: jobData.salary,
                    salaryMin: jobData.salaryMin,
                    salaryMax: jobData.salaryMax,
                    description: jobData.description,
                    active: jobData.active,
                    externalUrl: jobData.externalUrl,
                    lastFetchedAt: new Date()
                  }
                }
              }
            });
            totalUpdated++;
          } else {
            const applicationDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            bulkOps.push({
              insertOne: {
                document: {
                  ...jobData,
                  applicationDeadline
                }
              }
            });
            totalSaved++;
          }
        }

        if (bulkOps.length > 0) {
          const result = await Job.bulkWrite(bulkOps, { ordered: false });
          if (result.insertedIds) {
            Object.values(result.insertedIds).forEach(id => {
              setImmediate(() => generateJobEmbedding(id.toString()));
            });
          }
        }
      } catch (err) {
        console.error(`❌ [Ingestion] Adapter [${adapter.name}] failed:`, err.message);
        errors.push({ adapter: adapter.name, message: err.message });
      }
    }

    console.log(`📊 [Ingestion] Complete. Fetched: ${totalFetched}, Created: ${totalSaved}, Updated: ${totalUpdated}, Errors: ${errors.length}`);
    return {
      success: errors.length < this.adapters.length,
      totalFetched,
      created: totalSaved,
      updated: totalUpdated,
      errors
    };
  }
}

module.exports = new JobIngestionService();

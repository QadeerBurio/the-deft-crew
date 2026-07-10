import { logger } from '../config/logger';
import { backendDbConnection } from '../config/db';
import { SyncMetadata, ISyncMetadata } from '../models/SyncMetadata';
import { KnowledgeDocument } from '../models/KnowledgeDocument';
import { reindexService } from './reindex.service';
import { mongoVectorStore } from '../vector/mongoVectorStore';
import { adapters } from '../sync/adapters';
import { ApiError } from '../utils/ApiError';
import * as crypto from 'crypto';

export class SyncEngineService {
  private isSyncing = false;
  private currentSyncJob: {
    syncType: 'full' | 'incremental';
    status: 'in-progress' | 'success' | 'failed';
    startTime: Date;
    progress: string;
  } | null = null;

  /**
   * Triggers a full or incremental database synchronization run.
   */
  public async triggerSync(type: 'full' | 'incremental'): Promise<ISyncMetadata> {
    if (this.isSyncing) {
      throw new ApiError(409, 'A database synchronization job is already running.');
    }

    this.isSyncing = true;
    const startTime = new Date();
    this.currentSyncJob = {
      syncType: type,
      status: 'in-progress',
      startTime,
      progress: 'Connecting to backend database...',
    };

    logger.info(`Starting ${type} database synchronization engine...`);

    // Create sync metadata entry in 'in-progress' state
    const metadataDoc = new SyncMetadata({
      syncType: type,
      status: 'in-progress',
      createdAt: startTime,
      lastSyncTime: startTime,
    });
    await metadataDoc.save();

    // Run async in background to avoid blocking the HTTP thread
    (async () => {
      let totalSynced = 0;
      let totalFailed = 0;
      const statsAccumulator: Record<string, { count: number; failed: number }> = {};

      // Initialize statistics map for all adapters
      for (const adapter of adapters) {
        statsAccumulator[adapter.name] = { count: 0, failed: 0 };
      }

      try {
        // 1. Establish connection to Backend Database
        const conn = backendDbConnection;
        logger.info('Using shared persistent connection for backend sync.');

        // 2. Fetch last successful sync date if incremental
        let lastSyncedTime: Date | undefined;
        if (type === 'incremental') {
          const lastSuccessfulJob = await SyncMetadata.findOne({
            status: 'success',
            syncType: 'incremental',
          }).sort({ createdAt: -1 });

          if (lastSuccessfulJob) {
            lastSyncedTime = lastSuccessfulJob.lastSyncTime;
            logger.info(`Incremental sync reference date: ${lastSyncedTime.toISOString()}`);
          } else {
            logger.warn('No successful incremental sync job found. Falling back to Full Sync mode.');
          }
        }

        // 3. Process each adapter
        for (const adapter of adapters) {
          this.currentSyncJob!.progress = `Processing category: ${adapter.name}...`;
          logger.info(`Sync running for adapter: [${adapter.name}]`);

          try {
            // A. Fetch documents from backend
            const backendDocs = await adapter.fetchDocuments(conn, lastSyncedTime);
            logger.info(`Fetched ${backendDocs.length} items from backend collection "${adapter.collectionName}"`);

            const activeBackendIds = new Set<string>();

            // B. Map and upsert documents
            for (const rawDoc of backendDocs) {
              try {
                if (!rawDoc._id) continue;
                const originalId = rawDoc._id.toString();
                activeBackendIds.add(originalId);

                const input = adapter.mapToKnowledge(rawDoc);
                const contentHash = crypto.createHash('sha256').update(input.content).digest('hex');

                // Check if this document already exists in the AI database
                let existingDoc = await KnowledgeDocument.findOne({
                  category: adapter.name,
                  'metadata.originalId': originalId,
                });

                let needsReindexing = false;

                if (existingDoc) {
                  // Check if document was modified in backend
                  const isContentChanged = existingDoc.contentHash !== contentHash || existingDoc.title !== input.title;
                  const isStatusChanged = existingDoc.status !== input.status;

                  if (isContentChanged || isStatusChanged) {
                    existingDoc.title = input.title;
                    existingDoc.content = input.content;
                    existingDoc.contentHash = contentHash;
                    existingDoc.tags = input.tags;
                    existingDoc.status = input.status;
                    existingDoc.metadata = { ...existingDoc.metadata, ...input.metadata };
                    existingDoc.updatedAt = new Date();
                    await existingDoc.save();
                    needsReindexing = true;
                  }
                } else {
                  // Create new document
                  existingDoc = new KnowledgeDocument({
                    title: input.title,
                    category: adapter.name,
                    source: 'backend',
                    content: input.content,
                    contentHash,
                    tags: input.tags,
                    status: input.status,
                    metadata: input.metadata,
                  });
                  await existingDoc.save();
                  needsReindexing = true;
                }

                // C. Call Reindexing service to generate chunks & embeddings
                if (needsReindexing && existingDoc.status === 'published') {
                  await reindexService.reindexDocument(existingDoc);
                } else if (needsReindexing && existingDoc.status === 'archived') {
                  // If changed to archived, remove existing vectors
                  await mongoVectorStore.deleteVectors(existingDoc._id.toString());
                }

                statsAccumulator[adapter.name].count++;
                totalSynced++;
              } catch (docErr: any) {
                logger.error(`Failed to sync document ID ${rawDoc._id} inside adapter ${adapter.name}:`, docErr);
                statsAccumulator[adapter.name].failed++;
                totalFailed++;
              }
            }

            // D. Handle deletions (Incremental & Full cleanup)
            // Query all documents in AI database for this category that aren't archived
            if (type === 'full') {
              const aiDocs = await KnowledgeDocument.find({
                category: adapter.name,
                source: 'backend',
                status: { $ne: 'archived' },
              });

              for (const aiDoc of aiDocs) {
                const originalId = aiDoc.metadata?.originalId;
                if (originalId && !activeBackendIds.has(originalId)) {
                  // If it is in AI database but not in backend anymore, it was deleted!
                  logger.info(`Detected deleted backend document. Archiving AI document: "${aiDoc.title}" (Original ID: ${originalId})`);
                  aiDoc.status = 'archived';
                  aiDoc.updatedAt = new Date();
                  await aiDoc.save();

                  // Purge chunks from vector store
                  await mongoVectorStore.deleteVectors(aiDoc._id.toString());
                }
              }
            }

          } catch (adapterErr: any) {
            logger.error(`Sync adapter [${adapter.name}] encountered an exception:`, adapterErr);
          }
        }

        // 4. Mark Sync job completed successfully
        const endTime = new Date();
        const durationMs = endTime.getTime() - startTime.getTime();

        metadataDoc.status = 'success';
        metadataDoc.durationMs = durationMs;
        metadataDoc.totalSynced = totalSynced;
        metadataDoc.totalFailed = totalFailed;
        metadataDoc.stats = statsAccumulator as any;
        await metadataDoc.save();

        this.currentSyncJob!.status = 'success';
        this.currentSyncJob!.progress = `Sync completed in ${durationMs}ms.`;
        logger.info(`Database synchronization completed successfully. Synced: ${totalSynced}, Failed: ${totalFailed}. Duration: ${durationMs}ms`);

      } catch (err: any) {
        logger.error('CRITICAL: Sync Engine job crashed!', err);

        const endTime = new Date();
        const durationMs = endTime.getTime() - startTime.getTime();

        metadataDoc.status = 'failed';
        metadataDoc.durationMs = durationMs;
        metadataDoc.errorMessage = err.message || 'Unknown crash error';
        await metadataDoc.save();

        this.currentSyncJob!.status = 'failed';
        this.currentSyncJob!.progress = `Crashed: ${err.message}`;

      } finally {
        this.isSyncing = false;
      }
    })();

    return metadataDoc;
  }

  /**
   * Syncs a single source category (e.g. jobs).
   */
  public async triggerSourceSync(name: string): Promise<any> {
    const adapter = adapters.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!adapter) {
      throw new ApiError(404, `Sync source adapter "${name}" not found.`);
    }

    const startTime = new Date();
    logger.info(`Starting single source sync for: [${adapter.name}]`);

    let count = 0;
    let failed = 0;

    try {
      const conn = backendDbConnection;
      const backendDocs = await adapter.fetchDocuments(conn);
      logger.info(`Fetched ${backendDocs.length} items from backend for single sync.`);

      const activeBackendIds = new Set<string>();

      for (const rawDoc of backendDocs) {
        try {
          if (!rawDoc._id) continue;
          const originalId = rawDoc._id.toString();
          activeBackendIds.add(originalId);

          const input = adapter.mapToKnowledge(rawDoc);
          const contentHash = crypto.createHash('sha256').update(input.content).digest('hex');

          let existingDoc = await KnowledgeDocument.findOne({
            category: adapter.name,
            'metadata.originalId': originalId,
          });

          let needsReindexing = false;

          if (existingDoc) {
            const isContentChanged = existingDoc.contentHash !== contentHash || existingDoc.title !== input.title;
            const isStatusChanged = existingDoc.status !== input.status;

            if (isContentChanged || isStatusChanged) {
              existingDoc.title = input.title;
              existingDoc.content = input.content;
              existingDoc.contentHash = contentHash;
              existingDoc.tags = input.tags;
              existingDoc.status = input.status;
              existingDoc.metadata = { ...existingDoc.metadata, ...input.metadata };
              existingDoc.updatedAt = new Date();
              await existingDoc.save();
              needsReindexing = true;
            }
          } else {
            existingDoc = new KnowledgeDocument({
              title: input.title,
              category: adapter.name,
              source: 'backend',
              content: input.content,
              contentHash,
              tags: input.tags,
              status: input.status,
              metadata: input.metadata,
            });
            await existingDoc.save();
            needsReindexing = true;
          }

          if (needsReindexing && existingDoc.status === 'published') {
            await reindexService.reindexDocument(existingDoc);
          } else if (needsReindexing && existingDoc.status === 'archived') {
            await mongoVectorStore.deleteVectors(existingDoc._id.toString());
          }

          count++;
        } catch (docErr: any) {
          logger.error(`Single sync failed for doc ID ${rawDoc._id}:`, docErr);
          failed++;
        }
      }

      // Cleanup deleted items for this source
      const aiDocs = await KnowledgeDocument.find({
        category: adapter.name,
        source: 'backend',
        status: { $ne: 'archived' },
      });

      for (const aiDoc of aiDocs) {
        const originalId = aiDoc.metadata?.originalId;
        if (originalId && !activeBackendIds.has(originalId)) {
          logger.info(`Archiving deleted source document: "${aiDoc.title}"`);
          aiDoc.status = 'archived';
          await aiDoc.save();
          await mongoVectorStore.deleteVectors(aiDoc._id.toString());
        }
      }

      const durationMs = new Date().getTime() - startTime.getTime();
      return {
        success: true,
        source: adapter.name,
        synced: count,
        failed,
        durationMs,
      };

    } finally {
      // Shared connection is persistent, do not close it
    }
  }

  /**
   * Returns current sync engine status.
   */
  public async getSyncStatus(): Promise<any> {
    const lastJob = await SyncMetadata.findOne().sort({ createdAt: -1 });
    return {
      isSyncing: this.isSyncing,
      currentSyncJob: this.currentSyncJob,
      lastSyncJob: lastJob ? {
        syncType: lastJob.syncType,
        status: lastJob.status,
        durationMs: lastJob.durationMs,
        totalSynced: lastJob.totalSynced,
        totalFailed: lastJob.totalFailed,
        errorMessage: lastJob.errorMessage,
        createdAt: lastJob.createdAt,
      } : null,
    };
  }

  /**
   * Returns cumulative sync statistics.
   */
  public async getSyncStatistics(): Promise<any> {
    const totalJobs = await SyncMetadata.countDocuments();
    const successfulJobs = await SyncMetadata.countDocuments({ status: 'success' });
    const failedJobs = await SyncMetadata.countDocuments({ status: 'failed' });
    
    const categoryCounts = await KnowledgeDocument.aggregate([
      { $match: { source: 'backend' } },
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);

    const categories: Record<string, number> = {};
    for (const c of categoryCounts) {
      categories[c._id] = c.count;
    }

    return {
      totalRuns: totalJobs,
      successfulRuns: successfulJobs,
      failedRuns: failedJobs,
      documentsByCategory: categories,
    };
  }
}

export const syncEngineService = new SyncEngineService();
export default syncEngineService;

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncEngineService = exports.SyncEngineService = void 0;
const logger_1 = require("../config/logger");
const db_1 = require("../config/db");
const SyncMetadata_1 = require("../models/SyncMetadata");
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const reindex_service_1 = require("./reindex.service");
const mongoVectorStore_1 = require("../vector/mongoVectorStore");
const adapters_1 = require("../sync/adapters");
const ApiError_1 = require("../utils/ApiError");
const crypto = __importStar(require("crypto"));
class SyncEngineService {
    isSyncing = false;
    currentSyncJob = null;
    /**
     * Triggers a full or incremental database synchronization run.
     */
    async triggerSync(type) {
        if (this.isSyncing) {
            throw new ApiError_1.ApiError(409, 'A database synchronization job is already running.');
        }
        this.isSyncing = true;
        const startTime = new Date();
        this.currentSyncJob = {
            syncType: type,
            status: 'in-progress',
            startTime,
            progress: 'Connecting to backend database...',
        };
        logger_1.logger.info(`Starting ${type} database synchronization engine...`);
        // Create sync metadata entry in 'in-progress' state
        const metadataDoc = new SyncMetadata_1.SyncMetadata({
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
            const statsAccumulator = {};
            // Initialize statistics map for all adapters
            for (const adapter of adapters_1.adapters) {
                statsAccumulator[adapter.name] = { count: 0, failed: 0 };
            }
            try {
                // 1. Establish connection to Backend Database
                const conn = db_1.backendDbConnection;
                logger_1.logger.info('Using shared persistent connection for backend sync.');
                // 2. Fetch last successful sync date if incremental
                let lastSyncedTime;
                if (type === 'incremental') {
                    const lastSuccessfulJob = await SyncMetadata_1.SyncMetadata.findOne({
                        status: 'success',
                        syncType: 'incremental',
                    }).sort({ createdAt: -1 });
                    if (lastSuccessfulJob) {
                        lastSyncedTime = lastSuccessfulJob.lastSyncTime;
                        logger_1.logger.info(`Incremental sync reference date: ${lastSyncedTime.toISOString()}`);
                    }
                    else {
                        logger_1.logger.warn('No successful incremental sync job found. Falling back to Full Sync mode.');
                    }
                }
                // 3. Process each adapter
                for (const adapter of adapters_1.adapters) {
                    this.currentSyncJob.progress = `Processing category: ${adapter.name}...`;
                    logger_1.logger.info(`Sync running for adapter: [${adapter.name}]`);
                    try {
                        // A. Fetch documents from backend
                        const backendDocs = await adapter.fetchDocuments(conn, lastSyncedTime);
                        logger_1.logger.info(`Fetched ${backendDocs.length} items from backend collection "${adapter.collectionName}"`);
                        const activeBackendIds = new Set();
                        // B. Map and upsert documents
                        for (const rawDoc of backendDocs) {
                            try {
                                if (!rawDoc._id)
                                    continue;
                                const originalId = rawDoc._id.toString();
                                activeBackendIds.add(originalId);
                                const input = adapter.mapToKnowledge(rawDoc);
                                const contentHash = crypto.createHash('sha256').update(input.content).digest('hex');
                                // Check if this document already exists in the AI database
                                let existingDoc = await KnowledgeDocument_1.KnowledgeDocument.findOne({
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
                                }
                                else {
                                    // Create new document
                                    existingDoc = new KnowledgeDocument_1.KnowledgeDocument({
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
                                    await reindex_service_1.reindexService.reindexDocument(existingDoc);
                                }
                                else if (needsReindexing && existingDoc.status === 'archived') {
                                    // If changed to archived, remove existing vectors
                                    await mongoVectorStore_1.mongoVectorStore.deleteVectors(existingDoc._id.toString());
                                }
                                statsAccumulator[adapter.name].count++;
                                totalSynced++;
                            }
                            catch (docErr) {
                                logger_1.logger.error(`Failed to sync document ID ${rawDoc._id} inside adapter ${adapter.name}:`, docErr);
                                statsAccumulator[adapter.name].failed++;
                                totalFailed++;
                            }
                        }
                        // D. Handle deletions (Incremental & Full cleanup)
                        // Query all documents in AI database for this category that aren't archived
                        if (type === 'full') {
                            const aiDocs = await KnowledgeDocument_1.KnowledgeDocument.find({
                                category: adapter.name,
                                source: 'backend',
                                status: { $ne: 'archived' },
                            });
                            for (const aiDoc of aiDocs) {
                                const originalId = aiDoc.metadata?.originalId;
                                if (originalId && !activeBackendIds.has(originalId)) {
                                    // If it is in AI database but not in backend anymore, it was deleted!
                                    logger_1.logger.info(`Detected deleted backend document. Archiving AI document: "${aiDoc.title}" (Original ID: ${originalId})`);
                                    aiDoc.status = 'archived';
                                    aiDoc.updatedAt = new Date();
                                    await aiDoc.save();
                                    // Purge chunks from vector store
                                    await mongoVectorStore_1.mongoVectorStore.deleteVectors(aiDoc._id.toString());
                                }
                            }
                        }
                    }
                    catch (adapterErr) {
                        logger_1.logger.error(`Sync adapter [${adapter.name}] encountered an exception:`, adapterErr);
                    }
                }
                // 4. Mark Sync job completed successfully
                const endTime = new Date();
                const durationMs = endTime.getTime() - startTime.getTime();
                metadataDoc.status = 'success';
                metadataDoc.durationMs = durationMs;
                metadataDoc.totalSynced = totalSynced;
                metadataDoc.totalFailed = totalFailed;
                metadataDoc.stats = statsAccumulator;
                await metadataDoc.save();
                this.currentSyncJob.status = 'success';
                this.currentSyncJob.progress = `Sync completed in ${durationMs}ms.`;
                logger_1.logger.info(`Database synchronization completed successfully. Synced: ${totalSynced}, Failed: ${totalFailed}. Duration: ${durationMs}ms`);
            }
            catch (err) {
                logger_1.logger.error('CRITICAL: Sync Engine job crashed!', err);
                const endTime = new Date();
                const durationMs = endTime.getTime() - startTime.getTime();
                metadataDoc.status = 'failed';
                metadataDoc.durationMs = durationMs;
                metadataDoc.errorMessage = err.message || 'Unknown crash error';
                await metadataDoc.save();
                this.currentSyncJob.status = 'failed';
                this.currentSyncJob.progress = `Crashed: ${err.message}`;
            }
            finally {
                this.isSyncing = false;
            }
        })();
        return metadataDoc;
    }
    /**
     * Syncs a single source category (e.g. jobs).
     */
    async triggerSourceSync(name) {
        const adapter = adapters_1.adapters.find((a) => a.name.toLowerCase() === name.toLowerCase());
        if (!adapter) {
            throw new ApiError_1.ApiError(404, `Sync source adapter "${name}" not found.`);
        }
        const startTime = new Date();
        logger_1.logger.info(`Starting single source sync for: [${adapter.name}]`);
        let count = 0;
        let failed = 0;
        try {
            const conn = db_1.backendDbConnection;
            const backendDocs = await adapter.fetchDocuments(conn);
            logger_1.logger.info(`Fetched ${backendDocs.length} items from backend for single sync.`);
            const activeBackendIds = new Set();
            for (const rawDoc of backendDocs) {
                try {
                    if (!rawDoc._id)
                        continue;
                    const originalId = rawDoc._id.toString();
                    activeBackendIds.add(originalId);
                    const input = adapter.mapToKnowledge(rawDoc);
                    const contentHash = crypto.createHash('sha256').update(input.content).digest('hex');
                    let existingDoc = await KnowledgeDocument_1.KnowledgeDocument.findOne({
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
                    }
                    else {
                        existingDoc = new KnowledgeDocument_1.KnowledgeDocument({
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
                        await reindex_service_1.reindexService.reindexDocument(existingDoc);
                    }
                    else if (needsReindexing && existingDoc.status === 'archived') {
                        await mongoVectorStore_1.mongoVectorStore.deleteVectors(existingDoc._id.toString());
                    }
                    count++;
                }
                catch (docErr) {
                    logger_1.logger.error(`Single sync failed for doc ID ${rawDoc._id}:`, docErr);
                    failed++;
                }
            }
            // Cleanup deleted items for this source
            const aiDocs = await KnowledgeDocument_1.KnowledgeDocument.find({
                category: adapter.name,
                source: 'backend',
                status: { $ne: 'archived' },
            });
            for (const aiDoc of aiDocs) {
                const originalId = aiDoc.metadata?.originalId;
                if (originalId && !activeBackendIds.has(originalId)) {
                    logger_1.logger.info(`Archiving deleted source document: "${aiDoc.title}"`);
                    aiDoc.status = 'archived';
                    await aiDoc.save();
                    await mongoVectorStore_1.mongoVectorStore.deleteVectors(aiDoc._id.toString());
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
        }
        finally {
            // Shared connection is persistent, do not close it
        }
    }
    /**
     * Returns current sync engine status.
     */
    async getSyncStatus() {
        const lastJob = await SyncMetadata_1.SyncMetadata.findOne().sort({ createdAt: -1 });
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
    async getSyncStatistics() {
        const totalJobs = await SyncMetadata_1.SyncMetadata.countDocuments();
        const successfulJobs = await SyncMetadata_1.SyncMetadata.countDocuments({ status: 'success' });
        const failedJobs = await SyncMetadata_1.SyncMetadata.countDocuments({ status: 'failed' });
        const categoryCounts = await KnowledgeDocument_1.KnowledgeDocument.aggregate([
            { $match: { source: 'backend' } },
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ]);
        const categories = {};
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
exports.SyncEngineService = SyncEngineService;
exports.syncEngineService = new SyncEngineService();
exports.default = exports.syncEngineService;
//# sourceMappingURL=syncEngine.service.js.map
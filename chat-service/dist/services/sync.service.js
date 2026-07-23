"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncService = exports.SyncService = void 0;
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const logger_1 = require("../config/logger");
const ApiError_1 = require("../utils/ApiError");
const reindex_service_1 = require("./reindex.service");
class SyncService {
    supportedSources = [
        'scholarships',
        'jobs',
        'offers',
        'events',
        'universities',
        'notes',
        'books',
        'lectures',
        'past-papers',
    ];
    /**
     * Transforms and synchronizes updates from external TDC collections
     * into unified KnowledgeDocument indexes.
     */
    async syncSource(sourceName, payload) {
        const sourceKey = sourceName.toLowerCase().trim();
        if (!this.supportedSources.includes(sourceKey)) {
            throw new ApiError_1.ApiError(400, `Unsupported sync source: ${sourceName}`);
        }
        logger_1.logger.info(`Initiating synchronization for source category: [${sourceKey}]`);
        // Ensure we have a reference identifier
        const originalId = payload.id || payload._id;
        if (!originalId) {
            throw new ApiError_1.ApiError(400, 'Payload must contain a unique "id" or "_id" identifier.');
        }
        // Standardize raw schema details into standard knowledge context
        const title = payload.title || payload.name || 'Untitled Entry';
        const content = payload.content || payload.description || '';
        const tags = Array.isArray(payload.tags) ? payload.tags : [];
        // Capture other metadata variables
        const metadata = {
            ...payload.metadata,
            originalId,
            syncedAt: new Date(),
        };
        // Upsert into knowledge collection
        const document = await KnowledgeDocument_1.KnowledgeDocument.findOneAndUpdate({ category: sourceKey, 'metadata.originalId': originalId }, {
            title,
            category: sourceKey,
            source: 'tdc-sync-framework',
            content,
            tags,
            metadata,
            status: 'published',
        }, { upsert: true, new: true });
        logger_1.logger.info(`Successfully synced item: "${title}" [ID: ${originalId}] to Knowledge base`);
        // Asynchronously trigger chunking and vector index updates in the background
        reindex_service_1.reindexService.reindexDocument(document).catch((err) => {
            logger_1.logger.error(`Auto-reindexing failed for synced document ID ${document._id}:`, err);
        });
        return document;
    }
}
exports.SyncService = SyncService;
exports.syncService = new SyncService();
exports.default = exports.syncService;
//# sourceMappingURL=sync.service.js.map
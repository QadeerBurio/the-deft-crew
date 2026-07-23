"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStatistics = exports.searchKnowledge = exports.reindexDocument = exports.reindexAll = exports.listDocuments = exports.getDocument = exports.deleteDocument = exports.updateDocument = exports.createDocument = void 0;
const knowledge_service_1 = require("../services/knowledge.service");
const reindex_service_1 = require("../services/reindex.service");
const retrieval_service_1 = require("../services/retrieval.service");
const asyncHandler_1 = require("../utils/asyncHandler");
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const KnowledgeChunk_1 = require("../models/KnowledgeChunk");
const EmbeddingCache_1 = require("../models/EmbeddingCache");
const ApiError_1 = require("../utils/ApiError");
exports.createDocument = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await knowledge_service_1.knowledgeService.createDocument(req.body);
    res.status(201).json({
        success: true,
        data: doc,
    });
});
exports.updateDocument = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    const doc = await knowledge_service_1.knowledgeService.updateDocument(id, req.body);
    res.status(200).json({
        success: true,
        data: doc,
    });
});
exports.deleteDocument = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    await knowledge_service_1.knowledgeService.deleteDocument(id);
    res.status(200).json({
        success: true,
        message: 'Knowledge document deleted successfully',
    });
});
exports.getDocument = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    const doc = await knowledge_service_1.knowledgeService.getDocumentById(id);
    res.status(200).json({
        success: true,
        data: doc,
    });
});
exports.listDocuments = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { category, tag, status, limit, page, search } = req.query;
    if (search) {
        const results = await knowledge_service_1.knowledgeService.searchDocuments(String(search), category ? String(category) : undefined);
        res.status(200).json({
            success: true,
            count: results.length,
            data: results,
        });
        return;
    }
    const { documents, total } = await knowledge_service_1.knowledgeService.listDocuments({
        category: category ? String(category) : undefined,
        tag: tag ? String(tag) : undefined,
        status: status ? String(status) : undefined,
        limit: limit ? Number(limit) : undefined,
        page: page ? Number(page) : undefined,
    });
    res.status(200).json({
        success: true,
        total,
        page: Number(page) || 1,
        limit: Number(limit) || 20,
        data: documents,
    });
});
// === PHASE 5 VECTOR INDEXING & STATISTICS ENDPOINTS ===
/**
 * Triggers asynchronous full database vector reindexing.
 */
exports.reindexAll = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    await reindex_service_1.reindexService.reindexAll();
    res.status(202).json({
        success: true,
        message: 'Background full reindexing task scheduled successfully.',
    });
});
/**
 * Reindexes a single document by ID.
 */
exports.reindexDocument = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { id } = req.params;
    await reindex_service_1.reindexService.reindexDocumentById(id);
    res.status(200).json({
        success: true,
        message: `Document ID ${id} reindexed successfully.`,
    });
});
/**
 * Performs similarity queries across vectors, returning raw matching chunks and scores.
 */
exports.searchKnowledge = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { query, category } = req.body;
    if (!query || typeof query !== 'string') {
        throw new ApiError_1.ApiError(400, 'Search "query" parameter is required and must be a string.');
    }
    const result = await retrieval_service_1.retrievalService.retrieveRelevantContext(query, category);
    res.status(200).json({
        success: true,
        latencyMs: result.retrievalLatencyMs,
        count: result.sourceDocuments.length,
        data: result.sourceDocuments,
    });
});
/**
 * Exposes index statistics, counting documents, chunks, and cached embeddings.
 */
exports.getStatistics = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const [documentsCount, chunksCount, cacheCount] = await Promise.all([
        KnowledgeDocument_1.KnowledgeDocument.countDocuments(),
        KnowledgeChunk_1.KnowledgeChunk.countDocuments(),
        EmbeddingCache_1.EmbeddingCache.countDocuments(),
    ]);
    res.status(200).json({
        success: true,
        statistics: {
            documentsCount,
            chunksCount,
            cacheCount,
        },
    });
});
//# sourceMappingURL=knowledge.controller.js.map
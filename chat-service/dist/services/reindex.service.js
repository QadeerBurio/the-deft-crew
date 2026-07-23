"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reindexService = exports.ReindexService = void 0;
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const chunking_service_1 = require("./chunking.service");
const embedding_service_1 = require("./embedding.service");
const mongoVectorStore_1 = require("../vector/mongoVectorStore");
const logger_1 = require("../config/logger");
const ApiError_1 = require("../utils/ApiError");
class ReindexService {
    isReindexingAll = false;
    /**
     * Reindexes a single knowledge document.
     */
    async reindexDocument(doc) {
        const docId = doc._id.toString();
        logger_1.logger.info(`Started indexing document ID: ${docId} - "${doc.title}"`);
        try {
            // 1. Chunk document content preserving sentence boundaries
            const chunks = chunking_service_1.chunkingService.chunkText(doc.content);
            if (chunks.length === 0) {
                // If content is empty, just purge existing vectors
                await mongoVectorStore_1.mongoVectorStore.deleteVectors(docId);
                logger_1.logger.info(`Purged vectors for empty document ID: ${docId}`);
                return;
            }
            // 2. Fetch embeddings in batch for all text chunks
            const texts = chunks.map((c) => c.content);
            const embeddings = await embedding_service_1.embeddingService.getEmbeddingsBatch(texts);
            // 3. Prepare payload for Vector Store
            const vectorChunks = chunks.map((chunk, index) => ({
                docId,
                category: doc.category,
                chunkIndex: chunk.chunkIndex,
                content: chunk.content,
                embedding: embeddings[index],
                metadata: {
                    title: doc.title,
                    source: doc.source,
                    originalId: doc.metadata?.originalId,
                },
            }));
            // 4. Save vectors to store
            await mongoVectorStore_1.mongoVectorStore.upsertVectors(vectorChunks);
            logger_1.logger.info(`Completed reindexing document ID: ${docId}. Created ${chunks.length} chunks.`);
        }
        catch (error) {
            logger_1.logger.error(`Reindexing failed for document ID: ${docId}`, error);
            throw new ApiError_1.ApiError(500, `Reindexing error: ${error.message}`);
        }
    }
    /**
     * Reindexes a document by its Database ObjectId.
     */
    async reindexDocumentById(docId) {
        const doc = await KnowledgeDocument_1.KnowledgeDocument.findById(docId);
        if (!doc) {
            throw new ApiError_1.ApiError(404, 'Knowledge document not found');
        }
        await this.reindexDocument(doc);
    }
    /**
     * Executes a full reindexing of all published documents in the background.
     */
    async reindexAll() {
        if (this.isReindexingAll) {
            throw new ApiError_1.ApiError(409, 'A full database reindexing is already in progress.');
        }
        this.isReindexingAll = true;
        logger_1.logger.info('Initiating background reindexing of all knowledge documents...');
        // Run asynchronously in the background so request does not block HTTP thread
        (async () => {
            try {
                const documents = await KnowledgeDocument_1.KnowledgeDocument.find({ status: 'published' });
                logger_1.logger.info(`Found ${documents.length} published documents to reindex.`);
                let successCount = 0;
                let failCount = 0;
                for (const doc of documents) {
                    try {
                        await this.reindexDocument(doc);
                        successCount++;
                    }
                    catch (err) {
                        logger_1.logger.error(`Background reindex failed for doc ID ${doc._id}:`, err);
                        failCount++;
                    }
                }
                logger_1.logger.info(`Background reindex completed. Success: ${successCount}, Failed: ${failCount}`);
            }
            catch (error) {
                logger_1.logger.error('CRITICAL: Background reindex job failed!', error);
            }
            finally {
                this.isReindexingAll = false;
            }
        })();
    }
}
exports.ReindexService = ReindexService;
exports.reindexService = new ReindexService();
exports.default = exports.reindexService;
//# sourceMappingURL=reindex.service.js.map
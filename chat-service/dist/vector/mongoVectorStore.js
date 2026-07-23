"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mongoVectorStore = exports.MongoVectorStore = void 0;
const mongoose_1 = require("mongoose");
const KnowledgeChunk_1 = require("../models/KnowledgeChunk");
const logger_1 = require("../config/logger");
class MongoVectorStore {
    /**
     * Cleans old chunks for the document and inserts the new ones.
     */
    async upsertVectors(chunks) {
        if (chunks.length === 0)
            return;
        const docId = chunks[0].docId;
        // Purge existing chunks for this document first
        await this.deleteVectors(docId);
        // Prepare and insert bulk records
        const records = chunks.map((c) => ({
            docId: new mongoose_1.Types.ObjectId(c.docId),
            category: c.category.toLowerCase().trim(),
            chunkIndex: c.chunkIndex,
            content: c.content,
            embedding: c.embedding,
            metadata: c.metadata || {},
        }));
        await KnowledgeChunk_1.KnowledgeChunk.insertMany(records);
        logger_1.logger.info(`Persisted ${records.length} vector chunks to MongoDB store for docId: ${docId}`);
    }
    /**
     * Deletes all vector chunks associated with the document.
     */
    async deleteVectors(docId) {
        const result = await KnowledgeChunk_1.KnowledgeChunk.deleteMany({ docId: new mongoose_1.Types.ObjectId(docId) });
        if (result.deletedCount > 0) {
            logger_1.logger.info(`Purged ${result.deletedCount} old vector chunks for docId: ${docId}`);
        }
    }
    /**
     * Similarity search using standard cosine similarity formula.
     */
    async similaritySearch(queryEmbedding, topK, filter) {
        const query = {};
        if (filter?.category) {
            query.category = filter.category.toLowerCase().trim();
        }
        // Narrow candidate pool by keyword match if queryText is provided
        if (filter?.queryText && filter.queryText.trim().length > 0) {
            const keywords = filter.queryText
                .split(/\s+/)
                .filter(w => w.length > 2)
                .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
                .filter(w => w.length > 0);
            if (keywords.length > 0) {
                const keywordRegex = new RegExp(keywords.join('|'), 'i');
                query.content = keywordRegex;
            }
        }
        // Fetch candidate chunks from MongoDB with a hard limit of 300 to ensure performance
        let candidates = await KnowledgeChunk_1.KnowledgeChunk.find(query).select('+embedding').limit(300);
        // Fallback: if keyword filter returned 0, relax it to ensure we get general candidates
        if (candidates.length === 0 && query.content) {
            delete query.content;
            candidates = await KnowledgeChunk_1.KnowledgeChunk.find(query).select('+embedding').sort({ updatedAt: -1 }).limit(300);
        }
        const results = candidates.map((cand) => {
            const score = this.cosineSimilarity(queryEmbedding, cand.embedding);
            return {
                docId: cand.docId.toString(),
                chunkIndex: cand.chunkIndex,
                content: cand.content,
                score,
                metadata: cand.metadata,
            };
        });
        // Sort by descending score and take the top K results
        return results.sort((a, b) => b.score - a.score).slice(0, topK);
    }
    /**
     * Cosine Similarity calculation helper: (A . B) / (||A|| * ||B||)
     */
    cosineSimilarity(a, b) {
        if (a.length !== b.length)
            return 0;
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0)
            return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
}
exports.MongoVectorStore = MongoVectorStore;
exports.mongoVectorStore = new MongoVectorStore();
exports.default = exports.mongoVectorStore;
//# sourceMappingURL=mongoVectorStore.js.map
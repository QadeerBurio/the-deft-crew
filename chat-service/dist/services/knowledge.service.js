"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.knowledgeService = exports.KnowledgeService = void 0;
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../config/logger");
class KnowledgeService {
    /**
     * Registers a new knowledge document.
     */
    async createDocument(data) {
        try {
            logger_1.logger.info(`Creating knowledge document: "${data.title}" in category: ${data.category}`);
            const doc = new KnowledgeDocument_1.KnowledgeDocument(data);
            return await doc.save();
        }
        catch (error) {
            logger_1.logger.error('Failed to create knowledge document in DB:', error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
    /**
     * Updates an existing knowledge document.
     */
    async updateDocument(id, data) {
        try {
            logger_1.logger.info(`Updating knowledge document ID: ${id}`);
            const doc = await KnowledgeDocument_1.KnowledgeDocument.findByIdAndUpdate(id, data, {
                new: true,
                runValidators: true,
            });
            if (!doc) {
                throw new ApiError_1.ApiError(404, 'Knowledge document not found');
            }
            return doc;
        }
        catch (error) {
            if (error instanceof ApiError_1.ApiError) {
                throw error;
            }
            logger_1.logger.error(`Failed to update knowledge document ID ${id}:`, error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
    /**
     * Deletes a knowledge document.
     */
    async deleteDocument(id) {
        try {
            logger_1.logger.info(`Deleting knowledge document ID: ${id}`);
            const result = await KnowledgeDocument_1.KnowledgeDocument.findByIdAndDelete(id);
            if (!result) {
                throw new ApiError_1.ApiError(404, 'Knowledge document not found');
            }
        }
        catch (error) {
            if (error instanceof ApiError_1.ApiError) {
                throw error;
            }
            logger_1.logger.error(`Failed to delete knowledge document ID ${id}:`, error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
    /**
     * Fetches a single knowledge document by ID.
     */
    async getDocumentById(id) {
        try {
            const doc = await KnowledgeDocument_1.KnowledgeDocument.findById(id);
            if (!doc) {
                throw new ApiError_1.ApiError(404, 'Knowledge document not found');
            }
            return doc;
        }
        catch (error) {
            if (error instanceof ApiError_1.ApiError) {
                throw error;
            }
            logger_1.logger.error(`Failed to retrieve knowledge document ID ${id}:`, error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
    /**
     * Lists knowledge documents with dynamic filtering and pagination.
     */
    async listDocuments(filters) {
        try {
            const query = {};
            if (filters.category) {
                query.category = filters.category;
            }
            if (filters.tag) {
                query.tags = filters.tag;
            }
            if (filters.status) {
                query.status = filters.status;
            }
            const page = filters.page || 1;
            const limit = filters.limit || 20;
            const skip = (page - 1) * limit;
            const [documents, total] = await Promise.all([
                KnowledgeDocument_1.KnowledgeDocument.find(query).skip(skip).limit(limit).sort({ updatedAt: -1 }),
                KnowledgeDocument_1.KnowledgeDocument.countDocuments(query),
            ]);
            return { documents, total };
        }
        catch (error) {
            logger_1.logger.error('Failed to list knowledge documents:', error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
    /**
     * Performs a compound keyword text search.
     */
    async searchDocuments(textQuery, category) {
        try {
            const query = { $text: { $search: textQuery } };
            if (category) {
                query.category = category;
            }
            return await KnowledgeDocument_1.KnowledgeDocument.find(query)
                .select({ score: { $meta: 'textScore' } })
                .sort({ score: { $meta: 'textScore' } })
                .limit(10);
        }
        catch (error) {
            logger_1.logger.error(`Text search failure for query "${textQuery}":`, error);
            throw new ApiError_1.ApiError(500, `Database error: ${error.message}`);
        }
    }
}
exports.KnowledgeService = KnowledgeService;
exports.knowledgeService = new KnowledgeService();
exports.default = exports.knowledgeService;
//# sourceMappingURL=knowledge.service.js.map
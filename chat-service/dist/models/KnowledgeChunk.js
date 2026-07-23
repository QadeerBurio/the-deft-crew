"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeChunk = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const KnowledgeChunkSchema = new mongoose_1.Schema({
    docId: { type: mongoose_1.Schema.Types.ObjectId, ref: 'KnowledgeDocument', required: true, index: true },
    category: { type: String, required: true, index: true },
    chunkIndex: { type: Number, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    metadata: { type: mongoose_1.Schema.Types.Mixed, default: {} },
}, {
    timestamps: true,
    collection: 'knowledge_chunks',
});
// Compound index to speed up category and document-based lookups
KnowledgeChunkSchema.index({ category: 1, docId: 1 });
exports.KnowledgeChunk = db_1.aiDbConnection.model('KnowledgeChunk', KnowledgeChunkSchema);
exports.default = exports.KnowledgeChunk;
//# sourceMappingURL=KnowledgeChunk.js.map
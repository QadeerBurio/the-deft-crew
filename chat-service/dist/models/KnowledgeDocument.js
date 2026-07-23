"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeDocument = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const KnowledgeDocumentSchema = new mongoose_1.Schema({
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true },
    source: { type: String, required: true, index: true },
    content: { type: String, required: true },
    contentHash: { type: String, index: true },
    tags: [{ type: String, index: true }],
    status: {
        type: String,
        enum: ['draft', 'published', 'archived'],
        default: 'published',
        index: true,
    },
    metadata: { type: mongoose_1.Schema.Types.Mixed, default: {} },
}, {
    timestamps: true,
    collection: 'knowledge_documents',
});
// Compound text index for keyword and category search
KnowledgeDocumentSchema.index({ title: 'text', content: 'text' }, { weights: { title: 10, content: 2 } });
exports.KnowledgeDocument = db_1.aiDbConnection.model('KnowledgeDocument', KnowledgeDocumentSchema);
exports.default = exports.KnowledgeDocument;
//# sourceMappingURL=KnowledgeDocument.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingCache = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const EmbeddingCacheSchema = new mongoose_1.Schema({
    textHash: { type: String, required: true, unique: true, index: true },
    embedding: { type: [Number], required: true },
    createdAt: { type: Date, default: Date.now, expires: '30d' }, // Automatically prune caches after 30 days
}, {
    collection: 'embedding_caches',
});
exports.EmbeddingCache = db_1.aiDbConnection.model('EmbeddingCache', EmbeddingCacheSchema);
exports.default = exports.EmbeddingCache;
//# sourceMappingURL=EmbeddingCache.js.map
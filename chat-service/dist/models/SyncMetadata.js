"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncMetadata = void 0;
const mongoose_1 = require("mongoose");
const db_1 = require("../config/db");
const SourceSyncStatsSchema = new mongoose_1.Schema({
    count: { type: Number, default: 0 },
    failed: { type: Number, default: 0 }
}, { _id: false });
const SyncMetadataSchema = new mongoose_1.Schema({
    lastSyncTime: { type: Date, default: Date.now },
    syncType: { type: String, enum: ['full', 'incremental'], required: true },
    status: { type: String, enum: ['success', 'failed', 'in-progress'], required: true },
    durationMs: { type: Number, default: 0 },
    totalSynced: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
    stats: {
        scholarships: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        jobs: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        offers: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        events: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        universities: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        notes: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        books: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        lectures: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        pastPapers: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        packages: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        templates: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) },
        sliders: { type: SourceSyncStatsSchema, default: () => ({ count: 0, failed: 0 }) }
    },
    errorMessage: { type: String },
    createdAt: { type: Date, default: Date.now }
});
exports.SyncMetadata = db_1.aiDbConnection.model('SyncMetadata', SyncMetadataSchema);
exports.default = exports.SyncMetadata;
//# sourceMappingURL=SyncMetadata.js.map
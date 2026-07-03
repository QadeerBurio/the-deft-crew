import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface ISourceSyncStats {
  count: number;
  failed: number;
}

export interface ISyncMetadata {
  _id?: any;
  lastSyncTime: Date;
  syncType: 'full' | 'incremental';
  status: 'success' | 'failed' | 'in-progress';
  durationMs: number;
  totalSynced: number;
  totalFailed: number;
  stats: {
    scholarships: ISourceSyncStats;
    jobs: ISourceSyncStats;
    offers: ISourceSyncStats;
    events: ISourceSyncStats;
    universities: ISourceSyncStats;
    notes: ISourceSyncStats;
    books: ISourceSyncStats;
    lectures: ISourceSyncStats;
    pastPapers: ISourceSyncStats;
    packages: ISourceSyncStats;
    templates: ISourceSyncStats;
    sliders: ISourceSyncStats;
  };
  errorMessage?: string;
  createdAt: Date;
}

const SourceSyncStatsSchema = new Schema<ISourceSyncStats>({
  count: { type: Number, default: 0 },
  failed: { type: Number, default: 0 }
}, { _id: false });

const SyncMetadataSchema = new Schema<ISyncMetadata>({
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

export const SyncMetadata = aiDbConnection.model<ISyncMetadata>('SyncMetadata', SyncMetadataSchema);
export default SyncMetadata;

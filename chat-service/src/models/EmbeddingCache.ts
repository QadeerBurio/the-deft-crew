import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IEmbeddingCache {
  textHash: string;
  embedding: number[];
  createdAt?: Date;
}

const EmbeddingCacheSchema = new Schema<IEmbeddingCache>(
  {
    textHash: { type: String, required: true, unique: true, index: true },
    embedding: { type: [Number], required: true },
    createdAt: { type: Date, default: Date.now, expires: '30d' }, // Automatically prune caches after 30 days
  },
  {
    collection: 'embedding_caches',
  }
);

export const EmbeddingCache = aiDbConnection.model<IEmbeddingCache>('EmbeddingCache', EmbeddingCacheSchema);
export default EmbeddingCache;

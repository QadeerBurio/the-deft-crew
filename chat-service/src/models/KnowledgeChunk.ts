import { Schema, Types } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IKnowledgeChunk {
  docId: Types.ObjectId;
  category: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  createdAt?: Date;
  updatedAt?: Date;
}

const KnowledgeChunkSchema = new Schema<IKnowledgeChunk>(
  {
    docId: { type: Schema.Types.ObjectId, ref: 'KnowledgeDocument', required: true, index: true },
    category: { type: String, required: true, index: true },
    chunkIndex: { type: Number, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: 'knowledge_chunks',
  }
);

// Compound index to speed up category and document-based lookups
KnowledgeChunkSchema.index({ category: 1, docId: 1 });

export const KnowledgeChunk = aiDbConnection.model<IKnowledgeChunk>('KnowledgeChunk', KnowledgeChunkSchema);
export default KnowledgeChunk;

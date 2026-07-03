import { Schema } from 'mongoose';
import { aiDbConnection } from '../config/db';

export interface IKnowledgeDocument {
  _id?: any;
  title: string;
  category: string;
  source: string;
  content: string;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const KnowledgeDocumentSchema = new Schema<IKnowledgeDocument>(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true },
    source: { type: String, required: true, index: true },
    content: { type: String, required: true },
    tags: [{ type: String, index: true }],
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'published',
      index: true,
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: 'knowledge_documents',
  }
);

// Compound text index for keyword and category search
KnowledgeDocumentSchema.index(
  { title: 'text', content: 'text' },
  { weights: { title: 10, content: 2 } }
);

export const KnowledgeDocument = aiDbConnection.model<IKnowledgeDocument>(
  'KnowledgeDocument',
  KnowledgeDocumentSchema
);
export default KnowledgeDocument;

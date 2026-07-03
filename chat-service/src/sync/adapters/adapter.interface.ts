import mongoose from 'mongoose';

export interface IKnowledgeDocInput {
  title: string;
  category: string;
  source: string;
  content: string;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  metadata: Record<string, any>;
}

export interface ISyncAdapter {
  name: string;
  collectionName: string;
  fetchDocuments(conn: mongoose.Connection, lastSyncedTime?: Date): Promise<any[]>;
  mapToKnowledge(doc: any): IKnowledgeDocInput;
}

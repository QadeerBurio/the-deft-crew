import mongoose from 'mongoose';
import { ISyncAdapter, IKnowledgeDocInput } from './adapter.interface';

export class UniversitiesAdapter implements ISyncAdapter {
  name = 'universities';
  collectionName = 'universities';

  async fetchDocuments(conn: mongoose.Connection, _lastSyncedTime?: Date): Promise<any[]> {
    const db = conn.db;
    if (!db) return [];

    const query: Record<string, any> = {};
    // Note: University schema has no timestamps, so we fetch all each time for simplicity
    
    try {
      const docs = await db.collection(this.collectionName).find(query).toArray();
      return docs;
    } catch (err) {
      return [];
    }
  }

  mapToKnowledge(doc: any): IKnowledgeDocInput {
    const content = `University Name: ${doc.name || 'Unknown University'}
This university is registered with The Deft Crew platform for student verification and exclusive brand offers.`;

    return {
      title: doc.name || 'Unknown University',
      category: 'universities',
      source: 'backend',
      content,
      tags: ['university'],
      status: 'published',
      metadata: {
        originalId: doc._id.toString()
      }
    };
  }
}

import mongoose from 'mongoose';
import { ISyncAdapter, IKnowledgeDocInput } from './adapter.interface';

export class PackagesAdapter implements ISyncAdapter {
  name = 'packages';
  collectionName = 'packages';

  async fetchDocuments(conn: mongoose.Connection, _lastSyncedTime?: Date): Promise<any[]> {
    const db = conn.db;
    if (!db) return [];

    const query: Record<string, any> = {};
    // Note: Package has no timestamps, so we fetch all
    
    try {
      const docs = await db.collection(this.collectionName).find(query).toArray();
      return docs;
    } catch (err) {
      return [];
    }
  }

  mapToKnowledge(doc: any): IKnowledgeDocInput {
    const inclusionsStr = Array.isArray(doc.inclusions) ? doc.inclusions.map((i: string) => `• ${i}`).join('\n') : '';
    const reqsStr = Array.isArray(doc.requirements) ? doc.requirements.map((r: string) => `• ${r}`).join('\n') : '';
    
    const content = `Package Name: ${doc.name || 'Untitled Package'}
Category: ${doc.category || 'N/A'}
Price: $${doc.price || 0}
Location: ${doc.location || 'N/A'}
Description: ${doc.description || 'No description provided.'}

What's Included:
${inclusionsStr || 'None specified'}

Requirements:
${reqsStr || 'None specified'}`;

    return {
      title: doc.name || 'Untitled Package',
      category: 'packages',
      source: 'backend',
      content,
      tags: doc.category ? [doc.category] : [],
      status: 'published',
      metadata: {
        originalId: doc._id.toString(),
        price: doc.price,
        category: doc.category,
        location: doc.location
      }
    };
  }
}

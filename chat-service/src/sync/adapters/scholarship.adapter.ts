import mongoose from 'mongoose';
import { ISyncAdapter, IKnowledgeDocInput } from './adapter.interface';

export class ScholarshipAdapter implements ISyncAdapter {
  name = 'scholarships';
  collectionName = 'exchanges';

  async fetchDocuments(conn: mongoose.Connection, lastSyncedTime?: Date): Promise<any[]> {
    const db = conn.db;
    if (!db) return [];
    
    const query: Record<string, any> = {};
    if (lastSyncedTime) {
      query.updatedAt = { $gt: lastSyncedTime };
    }
    
    try {
      const docs = await db.collection(this.collectionName).find(query).toArray();
      return docs;
    } catch (err) {
      // If collection does not exist, return empty array gracefully
      return [];
    }
  }

  mapToKnowledge(doc: any): IKnowledgeDocInput {
    const requirementsStr = Array.isArray(doc.requirements) 
      ? doc.requirements.map((r: string) => `• ${r}`).join('\n') 
      : 'None specified';
      
    const deadlineStr = doc.deadline ? new Date(doc.deadline).toLocaleDateString() : 'N/A';
    
    const content = `Scholarship Title: ${doc.name || 'Untitled Scholarship'}
Amount: ${doc.amount || 'N/A'} ${doc.currency || 'USD'}
Description: ${doc.description || 'No description provided.'}
Deadline: ${deadlineStr}
Requirements:
${requirementsStr}`;

    return {
      title: doc.name || 'Untitled Scholarship',
      category: 'scholarships',
      source: 'backend',
      content,
      tags: Array.isArray(doc.requirements) ? doc.requirements : [],
      status: doc.active === false ? 'archived' : 'published',
      metadata: {
        originalId: doc._id.toString(),
        amount: doc.amount,
        currency: doc.currency,
        deadline: doc.deadline,
        programId: doc.programId ? doc.programId.toString() : undefined
      }
    };
  }
}

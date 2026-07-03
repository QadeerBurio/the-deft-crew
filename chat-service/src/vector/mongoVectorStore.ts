import { Types } from 'mongoose';
import { IVectorStore } from './vectorStore.interface';
import { KnowledgeChunk } from '../models/KnowledgeChunk';
import { logger } from '../config/logger';

export class MongoVectorStore implements IVectorStore {
  /**
   * Cleans old chunks for the document and inserts the new ones.
   */
  public async upsertVectors(
    chunks: Array<{
      docId: string;
      category: string;
      chunkIndex: number;
      content: string;
      embedding: number[];
      metadata: any;
    }>
  ): Promise<void> {
    if (chunks.length === 0) return;

    const docId = chunks[0].docId;
    
    // Purge existing chunks for this document first
    await this.deleteVectors(docId);

    // Prepare and insert bulk records
    const records = chunks.map((c) => ({
      docId: new Types.ObjectId(c.docId),
      category: c.category.toLowerCase().trim(),
      chunkIndex: c.chunkIndex,
      content: c.content,
      embedding: c.embedding,
      metadata: c.metadata || {},
    }));

    await KnowledgeChunk.insertMany(records);
    logger.info(`Persisted ${records.length} vector chunks to MongoDB store for docId: ${docId}`);
  }

  /**
   * Deletes all vector chunks associated with the document.
   */
  public async deleteVectors(docId: string): Promise<void> {
    const result = await KnowledgeChunk.deleteMany({ docId: new Types.ObjectId(docId) });
    if (result.deletedCount > 0) {
      logger.info(`Purged ${result.deletedCount} old vector chunks for docId: ${docId}`);
    }
  }

  /**
   * Similarity search using standard cosine similarity formula.
   */
  public async similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filter?: { category?: string }
  ): Promise<
    Array<{
      docId: string;
      chunkIndex: number;
      content: string;
      score: number;
      metadata: any;
    }>
  > {
    const query: any = {};
    if (filter?.category) {
      query.category = filter.category.toLowerCase().trim();
    }

    // Fetch candidate chunks from MongoDB
    const candidates = await KnowledgeChunk.find(query).select('+embedding');
    
    const results = candidates.map((cand) => {
      const score = this.cosineSimilarity(queryEmbedding, cand.embedding);
      return {
        docId: cand.docId.toString(),
        chunkIndex: cand.chunkIndex,
        content: cand.content,
        score,
        metadata: cand.metadata,
      };
    });

    // Sort by descending score and take the top K results
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Cosine Similarity calculation helper: (A . B) / (||A|| * ||B||)
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

export const mongoVectorStore = new MongoVectorStore();
export default mongoVectorStore;

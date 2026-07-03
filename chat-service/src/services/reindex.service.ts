import { KnowledgeDocument, IKnowledgeDocument } from '../models/KnowledgeDocument';
import { chunkingService } from './chunking.service';
import { embeddingService } from './embedding.service';
import { mongoVectorStore } from '../vector/mongoVectorStore';
import { logger } from '../config/logger';
import { ApiError } from '../utils/ApiError';

export class ReindexService {
  private isReindexingAll = false;

  /**
   * Reindexes a single knowledge document.
   */
  public async reindexDocument(doc: IKnowledgeDocument): Promise<void> {
    const docId = doc._id.toString();
    logger.info(`Started indexing document ID: ${docId} - "${doc.title}"`);
    
    try {
      // 1. Chunk document content preserving sentence boundaries
      const chunks = chunkingService.chunkText(doc.content);
      
      if (chunks.length === 0) {
        // If content is empty, just purge existing vectors
        await mongoVectorStore.deleteVectors(docId);
        logger.info(`Purged vectors for empty document ID: ${docId}`);
        return;
      }

      // 2. Fetch embeddings in batch for all text chunks
      const texts = chunks.map((c) => c.content);
      const embeddings = await embeddingService.getEmbeddingsBatch(texts);

      // 3. Prepare payload for Vector Store
      const vectorChunks = chunks.map((chunk, index) => ({
        docId,
        category: doc.category,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: embeddings[index],
        metadata: {
          title: doc.title,
          source: doc.source,
          originalId: doc.metadata?.originalId,
        },
      }));

      // 4. Save vectors to store
      await mongoVectorStore.upsertVectors(vectorChunks);
      logger.info(`Completed reindexing document ID: ${docId}. Created ${chunks.length} chunks.`);
    } catch (error: any) {
      logger.error(`Reindexing failed for document ID: ${docId}`, error);
      throw new ApiError(500, `Reindexing error: ${error.message}`);
    }
  }

  /**
   * Reindexes a document by its Database ObjectId.
   */
  public async reindexDocumentById(docId: string): Promise<void> {
    const doc = await KnowledgeDocument.findById(docId);
    if (!doc) {
      throw new ApiError(404, 'Knowledge document not found');
    }
    await this.reindexDocument(doc);
  }

  /**
   * Executes a full reindexing of all published documents in the background.
   */
  public async reindexAll(): Promise<void> {
    if (this.isReindexingAll) {
      throw new ApiError(409, 'A full database reindexing is already in progress.');
    }

    this.isReindexingAll = true;
    logger.info('Initiating background reindexing of all knowledge documents...');

    // Run asynchronously in the background so request does not block HTTP thread
    (async () => {
      try {
        const documents = await KnowledgeDocument.find({ status: 'published' });
        logger.info(`Found ${documents.length} published documents to reindex.`);
        
        let successCount = 0;
        let failCount = 0;

        for (const doc of documents) {
          try {
            await this.reindexDocument(doc);
            successCount++;
          } catch (err) {
            logger.error(`Background reindex failed for doc ID ${doc._id}:`, err);
            failCount++;
          }
        }

        logger.info(`Background reindex completed. Success: ${successCount}, Failed: ${failCount}`);
      } catch (error) {
        logger.error('CRITICAL: Background reindex job failed!', error);
      } finally {
        this.isReindexingAll = false;
      }
    })();
  }
}

export const reindexService = new ReindexService();
export default reindexService;

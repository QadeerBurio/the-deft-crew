import { embeddingService } from './embedding.service';
import { mongoVectorStore } from '../vector/mongoVectorStore';
import { env } from '../config/envValidator';
import { logger } from '../config/logger';
import { KnowledgeDocument } from '../models/KnowledgeDocument';

export interface RetrievedContext {
  contextText: string;
  sourceDocuments: Array<{
    docId: string;
    chunkIndex: number;
    score: number;
    title: string;
    source: string;
  }>;
  retrievalLatencyMs: number;
}

export class RetrievalService {
  /**
   * Translates text query to vector embedding, searches similarity store,
   * dedupes matching contents, and formats final RAG prompt contexts.
   */
  public async retrieveRelevantContext(
    query: string,
    category?: string
  ): Promise<RetrievedContext> {
    const startTime = Date.now();
    
    logger.info(`Starting RAG context retrieval for query: "${query}"`);

    // 1. Generate query embedding vector
    const queryEmbedding = await embeddingService.getEmbedding(query);
    const embeddingLatency = Date.now() - startTime;

    // 2. Perform similarity lookup in vector collection
    const searchStartTime = Date.now();
    const topK = env.TOP_K_RESULTS;
    const candidates = await mongoVectorStore.similaritySearch(
      queryEmbedding,
      topK,
      category ? { category } : undefined
    );
    const searchLatency = Date.now() - searchStartTime;

    // 3. Deduplicate text chunks by content
    const seenContent = new Set<string>();
    const uniqueChunks: typeof candidates = [];

    for (const cand of candidates) {
      const normalizedContent = cand.content.toLowerCase().trim();
      if (!seenContent.has(normalizedContent)) {
        seenContent.add(normalizedContent);
        uniqueChunks.push(cand);
      }
    }

    // 4. Assemble context up to character limitations
    let contextText = '';
    const maxChars = env.MAX_CONTEXT_CHARACTERS;
    const sourceDocuments: RetrievedContext['sourceDocuments'] = [];

    for (const chunk of uniqueChunks) {
      const nextSegment = `[Document: ${chunk.metadata?.title || 'Unknown'}] (Source: ${
        chunk.metadata?.source || 'unknown'
      })\n${chunk.content}\n\n`;

      if (contextText.length + nextSegment.length > maxChars) {
        logger.warn(`Context character cap reached (${maxChars} chars). Skipping remaining chunks.`);
        break;
      }

      contextText += nextSegment;
      sourceDocuments.push({
        docId: chunk.docId,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
        title: chunk.metadata?.title || 'Unknown',
        source: chunk.metadata?.source || 'unknown',
      });
    }

    const totalLatency = Date.now() - startTime;
    logger.info(
      `Retrieved RAG context. Latency details: ` +
        `[Total: ${totalLatency}ms, Embedding: ${embeddingLatency}ms, Search: ${searchLatency}ms]. ` +
        `Context Size: ${contextText.length} chars, Chunks retrieved: ${sourceDocuments.length}`
    );

    return {
      contextText: contextText.trim(),
      sourceDocuments,
      retrievalLatencyMs: totalLatency,
    };
  }

  /**
   * Directly queries the synced MongoDB database KnowledgeDocument collection
   * using text keywords or regex matching, returning formatted context text.
   */
  public async retrieveDirectDatabaseContext(
    intent: string,
    query: string,
    category?: string
  ): Promise<string> {
    let categoryFilter = category;
    
    // Map intent to unified KnowledgeDocument category values
    const intentLower = intent.toLowerCase();
    if (intentLower.includes('job') || intentLower.includes('career') || intentLower.includes('intern')) {
      categoryFilter = 'jobs';
    } else if (intentLower.includes('scholarship') || intentLower.includes('grant') || intentLower.includes('financial')) {
      categoryFilter = 'scholarships';
    } else if (intentLower.includes('discount') || intentLower.includes('offer') || intentLower.includes('deal')) {
      categoryFilter = 'offers';
    } else if (intentLower.includes('event') || intentLower.includes('mix') || intentLower.includes('hackathon')) {
      categoryFilter = 'events';
    } else if (intentLower.includes('university') || intentLower.includes('college')) {
      categoryFilter = 'universities';
    } else if (intentLower.includes('template') || intentLower.includes('cv') || intentLower.includes('resume')) {
      categoryFilter = 'templates';
    } else if (intentLower.includes('package') || intentLower.includes('tour') || intentLower.includes('travel')) {
      categoryFilter = 'packages';
    } else if (intentLower.includes('note') || intentLower.includes('book') || intentLower.includes('lecture') || intentLower.includes('past-paper')) {
      categoryFilter = 'notes';
    }

    if (!categoryFilter) return '';

    try {
      // Split query into keywords to do a flexible regex search
      const keywords = query.split(' ').filter(w => w.length > 2).map(w => w.trim());
      const queryRegex = keywords.length > 0 ? keywords.join('|') : query;

      const docs = await KnowledgeDocument.find({
        category: categoryFilter,
        status: 'published',
        $or: [
          { title: { $regex: queryRegex, $options: 'i' } },
          { content: { $regex: queryRegex, $options: 'i' } },
        ],
      }).limit(8);

      if (docs.length > 0) {
        logger.info(`Direct DB query retrieved ${docs.length} matches for category [${categoryFilter}]`);
        return docs.map(d => `[Database Match: ${d.title}] (Category: ${d.category})\nDescription/Details: ${d.content}\nMetadata: ${JSON.stringify(d.metadata)}`).join('\n\n');
      }

      // Default fallback: return latest 8 entries to avoid returning empty context
      const latestDocs = await KnowledgeDocument.find({
        category: categoryFilter,
        status: 'published',
      }).sort({ updatedAt: -1 }).limit(8);

      if (latestDocs.length > 0) {
        logger.info(`Direct DB query fell back to latest ${latestDocs.length} items for category [${categoryFilter}]`);
        return latestDocs.map(d => `[Database Match: ${d.title}] (Category: ${d.category})\nDescription/Details: ${d.content}\nMetadata: ${JSON.stringify(d.metadata)}`).join('\n\n');
      }
    } catch (err: any) {
      logger.error(`Error in direct database context query:`, err.message);
    }

    return '';
  }
}

export const retrievalService = new RetrievalService();
export default retrievalService;

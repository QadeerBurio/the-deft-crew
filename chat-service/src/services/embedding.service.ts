import crypto from 'crypto';
import { openaiService } from './openai.service';
import { EmbeddingCache } from '../models/EmbeddingCache';
import { logger } from '../config/logger';

export class EmbeddingService {
  /**
   * Computes a SHA-256 string hash for the input text.
   */
  private hashText(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Generates embedding for a single text segment. Checks database cache first.
   */
  public async getEmbedding(text: string): Promise<number[]> {
    const textHash = this.hashText(text);

    // 1. Search persistent cache
    const cached = await EmbeddingCache.findOne({ textHash });
    if (cached) {
      logger.debug(`Embedding cache hit for hash: ${textHash}`);
      return cached.embedding;
    }

    // 2. Fetch from OpenAI
    logger.info('Embedding cache miss. Dispatching API request to OpenAI...');
    const startTime = Date.now();
    const [embedding] = await openaiService.getEmbeddings(text);
    const duration = Date.now() - startTime;

    logger.info(`Generated embedding via OpenAI in ${duration}ms`);

    // 3. Write cache asynchronously
    EmbeddingCache.create({ textHash, embedding }).catch((err) => {
      logger.error('Failed to persist embedding cache record:', err);
    });

    return embedding;
  }

  /**
   * Generates embeddings in batch. Evaluates caches first and bundles misses.
   */
  public async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const hashes = texts.map((t) => this.hashText(t));
    const cachedRecords = await EmbeddingCache.find({ textHash: { $in: hashes } });
    
    // Build map for easy correlation
    const cacheMap = new Map<string, number[]>();
    for (const rec of cachedRecords) {
      cacheMap.set(rec.textHash, rec.embedding);
    }

    const results: number[][] = new Array(texts.length);
    const missIndexes: number[] = [];
    const missTexts: string[] = [];

    // Segregate cached items from API calls
    for (let i = 0; i < texts.length; i++) {
      const hash = hashes[i];
      if (cacheMap.has(hash)) {
        results[i] = cacheMap.get(hash)!;
      } else {
        missIndexes.push(i);
        missTexts.push(texts[i]);
      }
    }

    // Resolve API misses in a single batch call
    if (missTexts.length > 0) {
      logger.info(`Embedding batch miss. Querying OpenAI for ${missTexts.length} items...`);
      const startTime = Date.now();
      const newEmbeddings = await openaiService.getEmbeddings(missTexts);
      const duration = Date.now() - startTime;
      logger.info(`Generated batch of ${missTexts.length} embeddings in ${duration}ms`);

      const cacheDocs: Array<{ textHash: string; embedding: number[] }> = [];

      for (let j = 0; j < missTexts.length; j++) {
        const idx = missIndexes[j];
        const emb = newEmbeddings[j];
        const hash = hashes[idx];
        
        results[idx] = emb;
        cacheDocs.push({ textHash: hash, embedding: emb });
      }

      // Write newly retrieved vectors to cache
      EmbeddingCache.insertMany(cacheDocs, { ordered: false }).catch((err) => {
        logger.debug('Bulk cache save completed: ' + err.message);
      });
    }

    return results;
  }
}

export const embeddingService = new EmbeddingService();
export default embeddingService;

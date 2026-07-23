"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.embeddingService = exports.EmbeddingService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const openai_service_1 = require("./openai.service");
const EmbeddingCache_1 = require("../models/EmbeddingCache");
const logger_1 = require("../config/logger");
class EmbeddingService {
    /**
     * Computes a SHA-256 string hash for the input text.
     */
    hashText(text) {
        return crypto_1.default.createHash('sha256').update(text).digest('hex');
    }
    /**
     * Generates embedding for a single text segment. Checks database cache first.
     */
    async getEmbedding(text) {
        const textHash = this.hashText(text);
        // 1. Search persistent cache
        const cached = await EmbeddingCache_1.EmbeddingCache.findOne({ textHash });
        if (cached) {
            logger_1.logger.debug(`Embedding cache hit for hash: ${textHash}`);
            return cached.embedding;
        }
        // 2. Fetch from OpenAI
        logger_1.logger.info('Embedding cache miss. Dispatching API request to OpenAI...');
        const startTime = Date.now();
        const [embedding] = await openai_service_1.openaiService.getEmbeddings(text);
        const duration = Date.now() - startTime;
        logger_1.logger.info(`Generated embedding via OpenAI in ${duration}ms`);
        // 3. Write cache asynchronously
        EmbeddingCache_1.EmbeddingCache.create({ textHash, embedding }).catch((err) => {
            logger_1.logger.error('Failed to persist embedding cache record:', err);
        });
        return embedding;
    }
    /**
     * Generates embeddings in batch. Evaluates caches first and bundles misses.
     */
    async getEmbeddingsBatch(texts) {
        if (texts.length === 0)
            return [];
        const hashes = texts.map((t) => this.hashText(t));
        const cachedRecords = await EmbeddingCache_1.EmbeddingCache.find({ textHash: { $in: hashes } });
        // Build map for easy correlation
        const cacheMap = new Map();
        for (const rec of cachedRecords) {
            cacheMap.set(rec.textHash, rec.embedding);
        }
        const results = new Array(texts.length);
        const missIndexes = [];
        const missTexts = [];
        // Segregate cached items from API calls
        for (let i = 0; i < texts.length; i++) {
            const hash = hashes[i];
            if (cacheMap.has(hash)) {
                results[i] = cacheMap.get(hash);
            }
            else {
                missIndexes.push(i);
                missTexts.push(texts[i]);
            }
        }
        // Resolve API misses in a single batch call
        if (missTexts.length > 0) {
            logger_1.logger.info(`Embedding batch miss. Querying OpenAI for ${missTexts.length} items...`);
            const startTime = Date.now();
            const newEmbeddings = await openai_service_1.openaiService.getEmbeddings(missTexts);
            const duration = Date.now() - startTime;
            logger_1.logger.info(`Generated batch of ${missTexts.length} embeddings in ${duration}ms`);
            const cacheDocs = [];
            for (let j = 0; j < missTexts.length; j++) {
                const idx = missIndexes[j];
                const emb = newEmbeddings[j];
                const hash = hashes[idx];
                results[idx] = emb;
                cacheDocs.push({ textHash: hash, embedding: emb });
            }
            // Write newly retrieved vectors to cache
            EmbeddingCache_1.EmbeddingCache.insertMany(cacheDocs, { ordered: false }).catch((err) => {
                logger_1.logger.debug('Bulk cache save completed: ' + err.message);
            });
        }
        return results;
    }
}
exports.EmbeddingService = EmbeddingService;
exports.embeddingService = new EmbeddingService();
exports.default = exports.embeddingService;
//# sourceMappingURL=embedding.service.js.map
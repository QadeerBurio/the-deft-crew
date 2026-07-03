import { Request, Response } from 'express';
import { knowledgeService } from '../services/knowledge.service';
import { reindexService } from '../services/reindex.service';
import { retrievalService } from '../services/retrieval.service';
import { asyncHandler } from '../utils/asyncHandler';
import { KnowledgeDocument } from '../models/KnowledgeDocument';
import { KnowledgeChunk } from '../models/KnowledgeChunk';
import { EmbeddingCache } from '../models/EmbeddingCache';
import { ApiError } from '../utils/ApiError';

export const createDocument = asyncHandler(async (req: Request, res: Response) => {
  const doc = await knowledgeService.createDocument(req.body);
  res.status(201).json({
    success: true,
    data: doc,
  });
});

export const updateDocument = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const doc = await knowledgeService.updateDocument(id, req.body);
  res.status(200).json({
    success: true,
    data: doc,
  });
});

export const deleteDocument = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await knowledgeService.deleteDocument(id);
  res.status(200).json({
    success: true,
    message: 'Knowledge document deleted successfully',
  });
});

export const getDocument = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const doc = await knowledgeService.getDocumentById(id);
  res.status(200).json({
    success: true,
    data: doc,
  });
});

export const listDocuments = asyncHandler(async (req: Request, res: Response) => {
  const { category, tag, status, limit, page, search } = req.query;

  if (search) {
    const results = await knowledgeService.searchDocuments(
      String(search),
      category ? String(category) : undefined
    );
    res.status(200).json({
      success: true,
      count: results.length,
      data: results,
    });
    return;
  }

  const { documents, total } = await knowledgeService.listDocuments({
    category: category ? String(category) : undefined,
    tag: tag ? String(tag) : undefined,
    status: status ? String(status) : undefined,
    limit: limit ? Number(limit) : undefined,
    page: page ? Number(page) : undefined,
  });

  res.status(200).json({
    success: true,
    total,
    page: Number(page) || 1,
    limit: Number(limit) || 20,
    data: documents,
  });
});

// === PHASE 5 VECTOR INDEXING & STATISTICS ENDPOINTS ===

/**
 * Triggers asynchronous full database vector reindexing.
 */
export const reindexAll = asyncHandler(async (_req: Request, res: Response) => {
  await reindexService.reindexAll();
  res.status(202).json({
    success: true,
    message: 'Background full reindexing task scheduled successfully.',
  });
});

/**
 * Reindexes a single document by ID.
 */
export const reindexDocument = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  await reindexService.reindexDocumentById(id);
  res.status(200).json({
    success: true,
    message: `Document ID ${id} reindexed successfully.`,
  });
});

/**
 * Performs similarity queries across vectors, returning raw matching chunks and scores.
 */
export const searchKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { query, category } = req.body;
  if (!query || typeof query !== 'string') {
    throw new ApiError(400, 'Search "query" parameter is required and must be a string.');
  }

  const result = await retrievalService.retrieveRelevantContext(query, category);
  res.status(200).json({
    success: true,
    latencyMs: result.retrievalLatencyMs,
    count: result.sourceDocuments.length,
    data: result.sourceDocuments,
  });
});

/**
 * Exposes index statistics, counting documents, chunks, and cached embeddings.
 */
export const getStatistics = asyncHandler(async (_req: Request, res: Response) => {
  const [documentsCount, chunksCount, cacheCount] = await Promise.all([
    KnowledgeDocument.countDocuments(),
    KnowledgeChunk.countDocuments(),
    EmbeddingCache.countDocuments(),
  ]);

  res.status(200).json({
    success: true,
    statistics: {
      documentsCount,
      chunksCount,
      cacheCount,
    },
  });
});

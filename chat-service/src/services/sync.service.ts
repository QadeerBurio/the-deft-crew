import { KnowledgeDocument } from '../models/KnowledgeDocument';
import { logger } from '../config/logger';
import { ApiError } from '../utils/ApiError';
import { reindexService } from './reindex.service';

export class SyncService {
  private readonly supportedSources = [
    'scholarships',
    'jobs',
    'offers',
    'events',
    'universities',
    'notes',
    'books',
    'lectures',
    'past-papers',
  ];

  /**
   * Transforms and synchronizes updates from external TDC collections
   * into unified KnowledgeDocument indexes.
   */
  public async syncSource(sourceName: string, payload: any): Promise<any> {
    const sourceKey = sourceName.toLowerCase().trim();

    if (!this.supportedSources.includes(sourceKey)) {
      throw new ApiError(400, `Unsupported sync source: ${sourceName}`);
    }

    logger.info(`Initiating synchronization for source category: [${sourceKey}]`);

    // Ensure we have a reference identifier
    const originalId = payload.id || payload._id;
    if (!originalId) {
      throw new ApiError(400, 'Payload must contain a unique "id" or "_id" identifier.');
    }

    // Standardize raw schema details into standard knowledge context
    const title = payload.title || payload.name || 'Untitled Entry';
    const content = payload.content || payload.description || '';
    const tags = Array.isArray(payload.tags) ? payload.tags : [];
    
    // Capture other metadata variables
    const metadata = {
      ...payload.metadata,
      originalId,
      syncedAt: new Date(),
    };

    // Upsert into knowledge collection
    const document = await KnowledgeDocument.findOneAndUpdate(
      { category: sourceKey, 'metadata.originalId': originalId },
      {
        title,
        category: sourceKey,
        source: 'tdc-sync-framework',
        content,
        tags,
        metadata,
        status: 'published',
      },
      { upsert: true, new: true }
    );

    logger.info(`Successfully synced item: "${title}" [ID: ${originalId}] to Knowledge base`);
    
    // Asynchronously trigger chunking and vector index updates in the background
    reindexService.reindexDocument(document).catch((err) => {
      logger.error(`Auto-reindexing failed for synced document ID ${document._id}:`, err);
    });

    return document;
  }
}

export const syncService = new SyncService();
export default syncService;

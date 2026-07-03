import { KnowledgeDocument, IKnowledgeDocument } from '../models/KnowledgeDocument';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';

export class KnowledgeService {
  /**
   * Registers a new knowledge document.
   */
  public async createDocument(data: Partial<IKnowledgeDocument>): Promise<IKnowledgeDocument> {
    try {
      logger.info(`Creating knowledge document: "${data.title}" in category: ${data.category}`);
      const doc = new KnowledgeDocument(data);
      return await doc.save();
    } catch (error: any) {
      logger.error('Failed to create knowledge document in DB:', error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }

  /**
   * Updates an existing knowledge document.
   */
  public async updateDocument(
    id: string,
    data: Partial<IKnowledgeDocument>
  ): Promise<IKnowledgeDocument> {
    try {
      logger.info(`Updating knowledge document ID: ${id}`);
      const doc = await KnowledgeDocument.findByIdAndUpdate(id, data, {
        new: true,
        runValidators: true,
      });

      if (!doc) {
        throw new ApiError(404, 'Knowledge document not found');
      }

      return doc;
    } catch (error: any) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error(`Failed to update knowledge document ID ${id}:`, error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }

  /**
   * Deletes a knowledge document.
   */
  public async deleteDocument(id: string): Promise<void> {
    try {
      logger.info(`Deleting knowledge document ID: ${id}`);
      const result = await KnowledgeDocument.findByIdAndDelete(id);

      if (!result) {
        throw new ApiError(404, 'Knowledge document not found');
      }
    } catch (error: any) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error(`Failed to delete knowledge document ID ${id}:`, error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }

  /**
   * Fetches a single knowledge document by ID.
   */
  public async getDocumentById(id: string): Promise<IKnowledgeDocument> {
    try {
      const doc = await KnowledgeDocument.findById(id);
      if (!doc) {
        throw new ApiError(404, 'Knowledge document not found');
      }
      return doc;
    } catch (error: any) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error(`Failed to retrieve knowledge document ID ${id}:`, error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }

  /**
   * Lists knowledge documents with dynamic filtering and pagination.
   */
  public async listDocuments(filters: {
    category?: string;
    tag?: string;
    status?: string;
    limit?: number;
    page?: number;
  }): Promise<{ documents: IKnowledgeDocument[]; total: number }> {
    try {
      const query: any = {};
      
      if (filters.category) {
        query.category = filters.category;
      }
      if (filters.tag) {
        query.tags = filters.tag;
      }
      if (filters.status) {
        query.status = filters.status;
      }

      const page = filters.page || 1;
      const limit = filters.limit || 20;
      const skip = (page - 1) * limit;

      const [documents, total] = await Promise.all([
        KnowledgeDocument.find(query).skip(skip).limit(limit).sort({ updatedAt: -1 }),
        KnowledgeDocument.countDocuments(query),
      ]);

      return { documents, total };
    } catch (error: any) {
      logger.error('Failed to list knowledge documents:', error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }

  /**
   * Performs a compound keyword text search.
   */
  public async searchDocuments(
    textQuery: string,
    category?: string
  ): Promise<IKnowledgeDocument[]> {
    try {
      const query: any = { $text: { $search: textQuery } };
      
      if (category) {
        query.category = category;
      }

      return await KnowledgeDocument.find(query)
        .select({ score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(10);
    } catch (error: any) {
      logger.error(`Text search failure for query "${textQuery}":`, error);
      throw new ApiError(500, `Database error: ${error.message}`);
    }
  }
}

export const knowledgeService = new KnowledgeService();
export default knowledgeService;

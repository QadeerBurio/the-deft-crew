import { logger } from '../config/logger';

export interface IChunk {
  content: string;
  chunkIndex: number;
}

export class ChunkingService {
  /**
   * Splits a document text block into logical segments, preserving sentence boundaries.
   * Capped by targetChunkSize characters (~500 chars).
   */
  public chunkText(text: string, targetChunkSize = 500): IChunk[] {
    if (!text || text.trim() === '') {
      return [];
    }

    // Split text by sentence-ending punctuation followed by whitespace, keeping decimals intact
    const sentences = text.split(/(?<=[.!?])\s+/);
    
    const chunks: IChunk[] = [];
    let currentBuffer = '';
    let chunkIndex = 0;

    for (const sentence of sentences) {
      const sentenceText = sentence.trim();
      if (!sentenceText) continue;

      // If adding this sentence exceeds chunk size limit, save current chunk
      if (currentBuffer.length + sentenceText.length > targetChunkSize && currentBuffer.length > 0) {
        chunks.push({
          content: currentBuffer.trim(),
          chunkIndex,
        });
        currentBuffer = '';
        chunkIndex++;
      }

      currentBuffer += (currentBuffer ? ' ' : '') + sentenceText;
    }

    // Add any remaining text in buffer
    if (currentBuffer.trim()) {
      chunks.push({
        content: currentBuffer.trim(),
        chunkIndex,
      });
    }

    logger.debug(`Chunked text (length ${text.length}) into ${chunks.length} sentence-bounded chunks.`);
    return chunks;
  }
}

export const chunkingService = new ChunkingService();
export default chunkingService;

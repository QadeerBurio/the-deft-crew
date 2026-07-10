export interface IVectorStore {
  /**
   * Upserts a list of document chunks and their embedding vectors.
   */
  upsertVectors(
    chunks: Array<{
      docId: string;
      category: string;
      chunkIndex: number;
      content: string;
      embedding: number[];
      metadata: any;
    }>
  ): Promise<void>;

  /**
   * Deletes all vectors corresponding to a document.
   */
  deleteVectors(docId: string): Promise<void>;

  /**
   * Searches the store for the top K matching vectors using cosine similarity.
   */
  similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filter?: { category?: string; queryText?: string }
  ): Promise<
    Array<{
      docId: string;
      chunkIndex: number;
      content: string;
      score: number;
      metadata: any;
    }>
  >;
}
export default IVectorStore;

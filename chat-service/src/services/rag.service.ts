import { retrievalService } from './retrieval.service';
import { promptService } from './prompt.service';
import { openaiService } from './openai.service';
import { intentClassifier } from './intentClassifier';
import { logger } from '../config/logger';

export interface RAGResponse {
  reply: string;
  latencyMs: number;
  openaiLatencyMs: number;
  retrievalLatencyMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  modelUsed: string;
  sourceDocuments: Array<{
    docId: string;
    chunkIndex: number;
    score: number;
    title: string;
    source: string;
  }>;
}

export class RAGService {
  /**
   * Orchestrates the RAG flow: gets matching contexts, injects them into prompts,
   * requests chat completions, and aggregates performance details.
   */
  public async handleUserMessage(
    message: string,
    category?: string,
    historyMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [],
    userInfo?: { name: string; role: string; isGuest: boolean; university?: string }
  ): Promise<RAGResponse> {
    const startTime = Date.now();

    // 1. Retrieve matching context blocks from database directly and Vector Store
    const intent = await intentClassifier.classifyIntent(message);
    const directContext = await retrievalService.retrieveDirectDatabaseContext(intent, message, category);
    const retrievalResult = await retrievalService.retrieveRelevantContext(message, category);
    const retrievalLatencyMs = Date.now() - startTime;

    const combinedContext = [directContext, retrievalResult.contextText].filter(Boolean).join('\n\n');

    // 2. Build contextual prompts with user identity prefix
    let composedPrompt = promptService.getSystemInstructions(combinedContext);
    if (userInfo) {
      composedPrompt = `[User Identity Profile]
Name: ${userInfo.name}
Role: ${userInfo.role}
Is Guest: ${userInfo.isGuest}
${userInfo.university ? `University Reference ID: ${userInfo.university}` : ''}
Greet the user by their name if they greet you or if context is appropriate.
-----------------------
\n` + composedPrompt;
    }

    // 3. Dispatch queries to OpenAI completions (with history and tool execution support)
    const completionResult = await openaiService.getChatCompletion(
      composedPrompt,
      message,
      historyMessages
    );
    const totalLatencyMs = Date.now() - startTime;

    logger.info(
      `RAG Pipeline completed. Context chunks retrieved: ${retrievalResult.sourceDocuments.length}. ` +
        `Performance metrics: [Overall: ${totalLatencyMs}ms, Retrieval: ${retrievalLatencyMs}ms, OpenAI: ${completionResult.latencyMs}ms]`
    );

    return {
      reply: completionResult.reply,
      latencyMs: totalLatencyMs,
      openaiLatencyMs: completionResult.latencyMs,
      retrievalLatencyMs,
      usage: completionResult.usage,
      modelUsed: completionResult.modelUsed,
      sourceDocuments: retrievalResult.sourceDocuments,
    };
  }
}

export const ragService = new RAGService();
export default ragService;

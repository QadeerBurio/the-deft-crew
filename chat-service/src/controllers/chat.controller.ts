import { Response } from 'express';
import crypto from 'crypto';
import { ragService } from '../services/rag.service';
import { memoryService } from '../services/memory.service';
import { intentClassifier } from '../services/intentClassifier';
import { suggestionsService } from '../services/suggestionsService';
import { streamingService } from '../services/streaming.service';
import { retrievalService } from '../services/retrieval.service';
import { promptService } from '../services/prompt.service';
import { analyticsService } from '../services/analytics.service';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../config/logger';
import { ChatSession } from '../models/ChatSession';
import { ChatMessage } from '../models/ChatMessage';
import { ApiError } from '../utils/ApiError';
import { AuthenticatedRequest, AuthenticatedUser } from '../middleware/auth.middleware';
import { env } from '../config/envValidator';

/**
 * Helper to ensure a ChatSession is initialized or retrieved.
 */
async function getOrCreateSession(sessionId: string | undefined, userId: string): Promise<any> {
  let resolvedId = sessionId || crypto.randomUUID();
  let session = await ChatSession.findOne({ sessionId: resolvedId });
  let isNew = false;

  if (!session) {
    session = new ChatSession({
      sessionId: resolvedId,
      userId,
      title: 'New Conversation',
    });
    await session.save();
    isNew = true;
    logger.info(`Initialized new chat session: ${resolvedId} for user: ${userId}`);
  }

  return { session, isNew };
}

/**
 * POST /api/v1/chat/message
 * Standard JSON response chat handler incorporating short-term history,
 * long-term summaries, user personalization details, and intent classification.
 */
export const postMessage = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { message, sessionId: bodySessionId, category } = req.body;

  if (!message || message.trim() === '') {
    throw new ApiError(400, 'Message query is required.');
  }

  const startTime = Date.now();
  const user = req.user || { id: 'guest-user', name: 'Guest Student', role: 'guest', isGuest: true };

  // 1. Get or create chat session
  const { session, isNew } = await getOrCreateSession(bodySessionId, user.id);
  const sessionId = session.sessionId;

  // 2. Classify message intent
  const intent = await intentClassifier.classifyIntent(message);

  // 3. Persist user message in DB
  const userMsg = new ChatMessage({
    sessionId,
    role: 'user',
    message,
    intent,
  });
  await userMsg.save();

  // 4. Fetch context summary and short-term message logs
  const { messages: historyMessages } = await memoryService.getConversationContext(sessionId);

  // 5. Query Vector and execute LLM pipeline
  const chatResponse = await ragService.handleUserMessage(
    message,
    category,
    historyMessages,
    user
  );

  const latencyMs = Date.now() - startTime;

  // 6. Save Assistant Reply
  const assistantMsg = new ChatMessage({
    sessionId,
    role: 'assistant',
    message: chatResponse.reply,
    promptTokens: chatResponse.usage.inputTokens,
    completionTokens: chatResponse.usage.outputTokens,
    totalTokens: chatResponse.usage.totalTokens,
    model: chatResponse.modelUsed,
    intent,
    latencyMs,
    retrievalLatencyMs: chatResponse.retrievalLatencyMs,
    openaiLatencyMs: chatResponse.openaiLatencyMs,
    cacheHit: false, // Updated downstream if embedding matches
  });
  await assistantMsg.save();

  // 7. Update session timestamp
  session.updatedAt = new Date();
  await session.save();

  // 8. Auto-generate conversational title asynchronously for new threads
  if (isNew) {
    memoryService.generateSessionTitle(sessionId, message).catch((err) => {
      logger.error('Background title generation error:', err.message);
    });
  }

  // 9. Trigger background context compression check
  memoryService.compressContextIfNecessary(sessionId).catch((err) => {
    logger.error('Background compression error:', err.message);
  });

  res.status(200).json({
    success: true,
    reply: chatResponse.reply,
    sessionId,
    intent,
    latencyMs,
    usage: chatResponse.usage,
  });
});

/**
 * POST /api/v1/chat/stream
 * Server-Sent Events (SSE) streaming chat endpoint.
 */
export const postStream = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { message, sessionId: bodySessionId, category } = req.body;

  if (!message || message.trim() === '') {
    throw new ApiError(400, 'Message query is required.');
  }

  const startTime = Date.now();
  const user = req.user || ({ id: 'guest-user', name: 'Guest Student', role: 'guest', isGuest: true } as AuthenticatedUser);

  try {
    // Setup SSE connection headers immediately to register millisecond-level startup connection response
    streamingService.setupSSEHeaders(res);
    res.write(':\n\n'); // Send SSE comment heartbeat to open the stream right away

    // 1. Get or create session
    const { session, isNew } = await getOrCreateSession(bodySessionId, user.id);
    const sessionId = session.sessionId;

    // 2. Classify intent (instant local regex check)
    const intent = await intentClassifier.classifyIntent(message);

    // 3. Initiate context loading, database context, vector context, and user message persistence in parallel
    const directContextPromise = (intent !== 'Greeting' && intent !== 'Help')
      ? retrievalService.retrieveDirectDatabaseContext(intent, message, category)
      : Promise.resolve('');

    const relevantContextPromise = (intent !== 'Greeting' && intent !== 'Help')
      ? retrievalService.retrieveRelevantContext(message, category)
      : Promise.resolve({ contextText: '', sourceDocuments: [], retrievalLatencyMs: 0 });

    const conversationContextPromise = memoryService.getConversationContext(sessionId);

    const userMsg = new ChatMessage({
      sessionId,
      role: 'user',
      message,
      intent,
    });
    const userMsgSavePromise = userMsg.save();

    let combinedContext = '';
    let retrievalLatencyMs = 0;
    let historyMessages: any[] = [];

    try {
      const [directContext, retrievalResult, historyResult] = await Promise.all([
        directContextPromise,
        relevantContextPromise,
        conversationContextPromise,
        userMsgSavePromise
      ]);

      historyMessages = historyResult.messages;
      retrievalLatencyMs = Date.now() - startTime;
      combinedContext = [directContext, retrievalResult.contextText].filter(Boolean).join('\n\n');
    } catch (parallelErr: any) {
      logger.error('Parallel retrieval / context load error in streaming:', parallelErr.message);
      // Fallback: try loading conversation context if promise.all failed
      try {
        const historyResult = await conversationContextPromise;
        historyMessages = historyResult.messages;
      } catch (historyErr) {
        historyMessages = [];
      }
    }

    // Build the prompt instructions
    let composedPrompt = promptService.getSystemInstructions(combinedContext);
    if (user) {
      composedPrompt = `[User Identity Profile]
Name: ${user.name}
Role: ${user.role}
Is Guest: ${user.isGuest}
${user.university ? `University Reference ID: ${user.university}` : ''}
Greet the user by their name if they greet you or if context is appropriate.
-----------------------
\n` + composedPrompt;
    }

    // 6. Execute streaming loops
    await streamingService.streamChatCompletion(
      composedPrompt,
      message,
      historyMessages,
      res,
      async (fullReply, tokens) => {
        const overallLatency = Date.now() - startTime;

        // Persist generated reply
        const assistantMsg = new ChatMessage({
          sessionId,
          role: 'assistant',
          message: fullReply,
          promptTokens: tokens.prompt,
          completionTokens: tokens.completion,
          totalTokens: tokens.prompt + tokens.completion,
          model: env.OPENAI_MODEL,
          intent,
          latencyMs: overallLatency,
          retrievalLatencyMs,
          openaiLatencyMs: overallLatency - retrievalLatencyMs,
          cacheHit: false,
        });
        await assistantMsg.save();

        session.updatedAt = new Date();
        await session.save();

        if (isNew) {
          memoryService.generateSessionTitle(sessionId, message).catch((err) => {
            logger.error('Background title streaming error:', err.message);
          });
        }

        memoryService.compressContextIfNecessary(sessionId).catch((err) => {
          logger.error('Background compression streaming error:', err.message);
        });
      }
    );
  } catch (err: any) {
    logger.error('Fatal error in postStream controller:', err.message);
    if (!res.headersSent) {
      streamingService.setupSSEHeaders(res);
    }
    res.write(`data: ${JSON.stringify({ error: err.message || 'Streaming failed' })}\n\n`);
    res.end();
  }
});

/**
 * GET /api/v1/chat/sessions
 * Returns user sessions. Supports key-matching search on title and pinned sorting.
 */
export const getSessions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id || 'guest-user';
  const searchKey = req.query.q ? String(req.query.q) : undefined;

  logger.info(`Fetching sessions list for user: ${userId} (Query: ${searchKey})`);
  const sessions = await memoryService.searchSessions(userId, searchKey);

  res.status(200).json({
    success: true,
    count: sessions.length,
    data: sessions,
  });
});

/**
 * GET /api/v1/chat/history/:sessionId
 * Retrieves all chat message logs matching the sessionId.
 */
export const getHistory = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const userId = req.user?.id || 'guest-user';

  const session = await ChatSession.findOne({ sessionId });
  if (!session) {
    throw new ApiError(404, 'Chat session not found.');
  }

  // Ensure security isolation: users cannot read other users' sessions
  if (session.userId !== userId && userId !== 'admin') {
    throw new ApiError(403, 'Unauthorized access to session history.');
  }

  const messages = await ChatMessage.find({ sessionId }).sort({ createdAt: 1 });

  res.status(200).json({
    success: true,
    count: messages.length,
    data: messages,
  });
});

/**
 * DELETE /api/v1/chat/session/:sessionId
 * Soft-deletes (archives) a chat session.
 */
export const deleteSession = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId } = req.params;
  const userId = req.user?.id || 'guest-user';

  const session = await ChatSession.findOne({ sessionId });
  if (!session) {
    throw new ApiError(404, 'Chat session not found.');
  }

  if (session.userId !== userId && userId !== 'admin') {
    throw new ApiError(403, 'Unauthorized request.');
  }

  session.status = 'archived';
  await session.save();

  logger.info(`Archived session: ${sessionId}`);

  res.status(200).json({
    success: true,
    message: 'Chat session archived successfully.',
  });
});

/**
 * POST /api/v1/chat/title
 * Updates or auto-generates a session title.
 */
export const updateTitle = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { sessionId, title } = req.body;
  const userId = req.user?.id || 'guest-user';

  if (!sessionId) {
    throw new ApiError(400, 'Session ID is required.');
  }

  const session = await ChatSession.findOne({ sessionId });
  if (!session) {
    throw new ApiError(404, 'Chat session not found.');
  }

  if (session.userId !== userId && userId !== 'admin') {
    throw new ApiError(403, 'Unauthorized.');
  }

  let finalTitle = title;
  if (!finalTitle) {
    // Auto-generate title using first user query in history
    const firstMsg = await ChatMessage.findOne({ sessionId, role: 'user' }).sort({ createdAt: 1 });
    const querySample = firstMsg ? firstMsg.message : 'New Conversation';
    finalTitle = await memoryService.generateSessionTitle(sessionId, querySample);
  } else {
    session.title = finalTitle;
    await session.save();
  }

  res.status(200).json({
    success: true,
    title: finalTitle,
  });
});

/**
 * GET /api/v1/chat/suggestions
 * Returns 3 dynamic recommended follow-up options.
 */
export const getSuggestions = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
  let historyText = '';

  if (sessionId) {
    const logs = await ChatMessage.find({ sessionId }).sort({ createdAt: -1 }).limit(4);
    historyText = logs.map((m) => m.message).join(' ');
  }

  const suggestions = suggestionsService.getDynamicSuggestions(historyText);

  res.status(200).json({
    success: true,
    data: suggestions,
  });
});

/**
 * GET /api/v1/chat/status
 * Returns system performance metrics, DAU details, latency averages, and cache hits.
 */
export const getStatus = asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const stats = await analyticsService.getAnalyticsSummary();

  res.status(200).json({
    success: true,
    status: 'healthy',
    uptimeSeconds: process.uptime(),
    metrics: stats,
  });
});

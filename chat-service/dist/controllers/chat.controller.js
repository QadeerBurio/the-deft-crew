"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStatus = exports.getSuggestions = exports.updateTitle = exports.deleteSession = exports.getHistory = exports.getSessions = exports.postStream = exports.postMessage = void 0;
const crypto_1 = __importDefault(require("crypto"));
const rag_service_1 = require("../services/rag.service");
const memory_service_1 = require("../services/memory.service");
const intentClassifier_1 = require("../services/intentClassifier");
const suggestionsService_1 = require("../services/suggestionsService");
const streaming_service_1 = require("../services/streaming.service");
const retrieval_service_1 = require("../services/retrieval.service");
const prompt_service_1 = require("../services/prompt.service");
const analytics_service_1 = require("../services/analytics.service");
const asyncHandler_1 = require("../utils/asyncHandler");
const logger_1 = require("../config/logger");
const ChatSession_1 = require("../models/ChatSession");
const ChatMessage_1 = require("../models/ChatMessage");
const ApiError_1 = require("../utils/ApiError");
const envValidator_1 = require("../config/envValidator");
/**
 * Helper to ensure a ChatSession is initialized or retrieved.
 */
async function getOrCreateSession(sessionId, userId) {
    let resolvedId = sessionId || crypto_1.default.randomUUID();
    let session = await ChatSession_1.ChatSession.findOne({ sessionId: resolvedId });
    let isNew = false;
    if (!session) {
        session = new ChatSession_1.ChatSession({
            sessionId: resolvedId,
            userId,
            title: 'New Conversation',
        });
        await session.save();
        isNew = true;
        logger_1.logger.info(`Initialized new chat session: ${resolvedId} for user: ${userId}`);
    }
    return { session, isNew };
}
/**
 * POST /api/v1/chat/message
 * Standard JSON response chat handler incorporating short-term history,
 * long-term summaries, user personalization details, and intent classification.
 */
exports.postMessage = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { message, sessionId: bodySessionId, category } = req.body;
    if (!message || message.trim() === '') {
        throw new ApiError_1.ApiError(400, 'Message query is required.');
    }
    const startTime = Date.now();
    const user = req.user || { id: 'guest-user', name: 'Guest Student', role: 'guest', isGuest: true };
    // 1. Get or create chat session
    const { session, isNew } = await getOrCreateSession(bodySessionId, user.id);
    const sessionId = session.sessionId;
    // 2. Classify message intent
    const intent = await intentClassifier_1.intentClassifier.classifyIntent(message);
    // 3. Persist user message in DB
    const userMsg = new ChatMessage_1.ChatMessage({
        sessionId,
        role: 'user',
        message,
        intent,
    });
    await userMsg.save();
    // 4. Fetch context summary and short-term message logs
    const { messages: historyMessages } = await memory_service_1.memoryService.getConversationContext(sessionId);
    // 5. Query Vector and execute LLM pipeline
    const chatResponse = await rag_service_1.ragService.handleUserMessage(message, category, historyMessages, user);
    const latencyMs = Date.now() - startTime;
    // 6. Save Assistant Reply
    const assistantMsg = new ChatMessage_1.ChatMessage({
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
        memory_service_1.memoryService.generateSessionTitle(sessionId, message).catch((err) => {
            logger_1.logger.error('Background title generation error:', err.message);
        });
    }
    // 9. Trigger background context compression check
    memory_service_1.memoryService.compressContextIfNecessary(sessionId).catch((err) => {
        logger_1.logger.error('Background compression error:', err.message);
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
exports.postStream = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { message, sessionId: bodySessionId, category } = req.body;
    if (!message || message.trim() === '') {
        throw new ApiError_1.ApiError(400, 'Message query is required.');
    }
    const startTime = Date.now();
    const user = req.user || { id: 'guest-user', name: 'Guest Student', role: 'guest', isGuest: true };
    try {
        // Setup SSE connection headers immediately to register millisecond-level startup connection response
        streaming_service_1.streamingService.setupSSEHeaders(res);
        res.write(':\n\n'); // Send SSE comment heartbeat to open the stream right away
        // 1. Get or create session
        const { session, isNew } = await getOrCreateSession(bodySessionId, user.id);
        const sessionId = session.sessionId;
        // 2. Classify intent (instant local regex check)
        const intent = await intentClassifier_1.intentClassifier.classifyIntent(message);
        // 3. Initiate context loading, database context, vector context, and user message persistence in parallel
        const directContextPromise = (intent !== 'Greeting' && intent !== 'Help')
            ? retrieval_service_1.retrievalService.retrieveDirectDatabaseContext(intent, message, category)
            : Promise.resolve('');
        const relevantContextPromise = (intent !== 'Greeting' && intent !== 'Help')
            ? retrieval_service_1.retrievalService.retrieveRelevantContext(message, category)
            : Promise.resolve({ contextText: '', sourceDocuments: [], retrievalLatencyMs: 0 });
        const conversationContextPromise = memory_service_1.memoryService.getConversationContext(sessionId);
        const userMsg = new ChatMessage_1.ChatMessage({
            sessionId,
            role: 'user',
            message,
            intent,
        });
        const userMsgSavePromise = userMsg.save();
        let combinedContext = '';
        let retrievalLatencyMs = 0;
        let historyMessages = [];
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
        }
        catch (parallelErr) {
            logger_1.logger.error('Parallel retrieval / context load error in streaming:', parallelErr.message);
            // Fallback: try loading conversation context if promise.all failed
            try {
                const historyResult = await conversationContextPromise;
                historyMessages = historyResult.messages;
            }
            catch (historyErr) {
                historyMessages = [];
            }
        }
        // Build the prompt instructions
        let composedPrompt = prompt_service_1.promptService.getSystemInstructions(combinedContext);
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
        await streaming_service_1.streamingService.streamChatCompletion(composedPrompt, message, historyMessages, res, async (fullReply, tokens) => {
            const overallLatency = Date.now() - startTime;
            // Persist generated reply
            const assistantMsg = new ChatMessage_1.ChatMessage({
                sessionId,
                role: 'assistant',
                message: fullReply,
                promptTokens: tokens.prompt,
                completionTokens: tokens.completion,
                totalTokens: tokens.prompt + tokens.completion,
                model: envValidator_1.env.OPENAI_MODEL,
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
                memory_service_1.memoryService.generateSessionTitle(sessionId, message).catch((err) => {
                    logger_1.logger.error('Background title streaming error:', err.message);
                });
            }
            memory_service_1.memoryService.compressContextIfNecessary(sessionId).catch((err) => {
                logger_1.logger.error('Background compression streaming error:', err.message);
            });
        });
    }
    catch (err) {
        logger_1.logger.error('Fatal error in postStream controller:', err.message);
        if (!res.headersSent) {
            streaming_service_1.streamingService.setupSSEHeaders(res);
        }
        res.write(`data: ${JSON.stringify({ error: err.message || 'Streaming failed' })}\n\n`);
        res.end();
    }
});
/**
 * GET /api/v1/chat/sessions
 * Returns user sessions. Supports key-matching search on title and pinned sorting.
 */
exports.getSessions = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const userId = req.user?.id || 'guest-user';
    const searchKey = req.query.q ? String(req.query.q) : undefined;
    logger_1.logger.info(`Fetching sessions list for user: ${userId} (Query: ${searchKey})`);
    const sessions = await memory_service_1.memoryService.searchSessions(userId, searchKey);
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
exports.getHistory = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user?.id || 'guest-user';
    const session = await ChatSession_1.ChatSession.findOne({ sessionId });
    if (!session) {
        throw new ApiError_1.ApiError(404, 'Chat session not found.');
    }
    // Ensure security isolation: users cannot read other users' sessions
    if (session.userId !== userId && userId !== 'admin') {
        throw new ApiError_1.ApiError(403, 'Unauthorized access to session history.');
    }
    const messages = await ChatMessage_1.ChatMessage.find({ sessionId }).sort({ createdAt: 1 });
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
exports.deleteSession = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { sessionId } = req.params;
    const userId = req.user?.id || 'guest-user';
    const session = await ChatSession_1.ChatSession.findOne({ sessionId });
    if (!session) {
        throw new ApiError_1.ApiError(404, 'Chat session not found.');
    }
    if (session.userId !== userId && userId !== 'admin') {
        throw new ApiError_1.ApiError(403, 'Unauthorized request.');
    }
    session.status = 'archived';
    await session.save();
    logger_1.logger.info(`Archived session: ${sessionId}`);
    res.status(200).json({
        success: true,
        message: 'Chat session archived successfully.',
    });
});
/**
 * POST /api/v1/chat/title
 * Updates or auto-generates a session title.
 */
exports.updateTitle = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { sessionId, title } = req.body;
    const userId = req.user?.id || 'guest-user';
    if (!sessionId) {
        throw new ApiError_1.ApiError(400, 'Session ID is required.');
    }
    const session = await ChatSession_1.ChatSession.findOne({ sessionId });
    if (!session) {
        throw new ApiError_1.ApiError(404, 'Chat session not found.');
    }
    if (session.userId !== userId && userId !== 'admin') {
        throw new ApiError_1.ApiError(403, 'Unauthorized.');
    }
    let finalTitle = title;
    if (!finalTitle) {
        // Auto-generate title using first user query in history
        const firstMsg = await ChatMessage_1.ChatMessage.findOne({ sessionId, role: 'user' }).sort({ createdAt: 1 });
        const querySample = firstMsg ? firstMsg.message : 'New Conversation';
        finalTitle = await memory_service_1.memoryService.generateSessionTitle(sessionId, querySample);
    }
    else {
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
exports.getSuggestions = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    let historyText = '';
    if (sessionId) {
        const logs = await ChatMessage_1.ChatMessage.find({ sessionId }).sort({ createdAt: -1 }).limit(4);
        historyText = logs.map((m) => m.message).join(' ');
    }
    const suggestions = suggestionsService_1.suggestionsService.getDynamicSuggestions(historyText);
    res.status(200).json({
        success: true,
        data: suggestions,
    });
});
/**
 * GET /api/v1/chat/status
 * Returns system performance metrics, DAU details, latency averages, and cache hits.
 */
exports.getStatus = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const stats = await analytics_service_1.analyticsService.getAnalyticsSummary();
    res.status(200).json({
        success: true,
        status: 'healthy',
        uptimeSeconds: process.uptime(),
        metrics: stats,
    });
});
//# sourceMappingURL=chat.controller.js.map
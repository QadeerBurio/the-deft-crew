"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryService = exports.MemoryService = void 0;
const ChatMessage_1 = require("../models/ChatMessage");
const ChatSession_1 = require("../models/ChatSession");
const ConversationMemory_1 = require("../models/ConversationMemory");
const openai_service_1 = require("./openai.service");
const logger_1 = require("../config/logger");
class MemoryService {
    /**
     * Retrieves short-term messages and long-term summary context for prompt feeding.
     */
    async getConversationContext(sessionId) {
        // 1. Fetch long-term summary
        const memory = await ConversationMemory_1.ConversationMemory.findOne({ sessionId });
        const summary = memory ? memory.summary : '';
        // 2. Fetch last 6 messages
        const chatLogs = await ChatMessage_1.ChatMessage.find({ sessionId })
            .sort({ createdAt: -1 })
            .limit(6);
        // Sort chronologically
        const sortedLogs = [...chatLogs].reverse();
        const messages = sortedLogs.map((log) => ({
            role: log.role,
            content: log.message,
        }));
        let historyText = '';
        if (summary) {
            historyText += `[Long-Term Context Summary]: ${summary}\n\n`;
        }
        historyText += sortedLogs
            .map((log) => `${log.role === 'user' ? 'User' : 'Assistant'}: ${log.message}`)
            .join('\n');
        return {
            historyText,
            summary,
            messages,
        };
    }
    /**
     * Triggers background context compression if the conversation history grows too large.
     */
    async compressContextIfNecessary(sessionId) {
        try {
            const msgCount = await ChatMessage_1.ChatMessage.countDocuments({ sessionId });
            if (msgCount <= 8)
                return;
            // Run asynchronously in the background
            (async () => {
                logger_1.logger.info(`Running background context compression for session: ${sessionId}`);
                // Load all except the last 4 messages (which we preserve as active short-term memory)
                const messages = await ChatMessage_1.ChatMessage.find({ sessionId }).sort({ createdAt: 1 });
                const summaryCandidates = messages.slice(0, -4);
                if (summaryCandidates.length === 0)
                    return;
                // Fetch existing summary
                let existingSummary = '';
                const memory = await ConversationMemory_1.ConversationMemory.findOne({ sessionId });
                if (memory) {
                    existingSummary = memory.summary;
                }
                const logString = summaryCandidates
                    .map((m) => `${m.role}: ${m.message}`)
                    .join('\n');
                const prompt = `You are a context compiler. Consolidate the following chat history and existing summary into a single, cohesive, highly concise summary of key facts discussed.
Do NOT lose details about active TDC scholarships, jobs, or offers discussed.
Limit your summary to under 3-4 sentences.

Existing Summary: "${existingSummary}"

New Conversation to merge:
${logString}

New Consolidated Summary:`;
                const completion = await openai_service_1.openaiService.getChatCompletion('You summarize chat logs. Keep it factual and brief.', prompt);
                const newSummary = completion.reply.trim();
                // Save new summary
                await ConversationMemory_1.ConversationMemory.findOneAndUpdate({ sessionId }, { summary: newSummary }, { upsert: true, new: true });
                logger_1.logger.info(`Context compressed successfully. New Summary: "${newSummary}"`);
            })();
        }
        catch (err) {
            logger_1.logger.error('Failed to execute context compression:', err.message);
        }
    }
    /**
     * Generates a short, descriptive 3-5 word title based on the first query.
     */
    async generateSessionTitle(sessionId, firstQuery) {
        try {
            const prompt = `Analyze the student query and generate a short, clean, descriptive conversation title (3 to 5 words maximum). Do NOT put quotes or punctuation.
Query: "${firstQuery}"
Title:`;
            const completion = await openai_service_1.openaiService.getChatCompletion('You write short, concise conversation titles.', prompt);
            const title = completion.reply.trim().replace(/["']/g, '');
            await ChatSession_1.ChatSession.findOneAndUpdate({ sessionId }, { title });
            logger_1.logger.info(`Auto-generated title for session ${sessionId}: "${title}"`);
            return title;
        }
        catch (err) {
            logger_1.logger.error(`Failed to generate title for session ${sessionId}:`, err.message);
            return 'New Conversation';
        }
    }
    /**
     * Queries and searches user sessions list (supports title queries and pinned priority).
     */
    async searchSessions(userId, searchKey) {
        const query = { userId, status: 'active' };
        if (searchKey) {
            query.title = { $regex: searchKey, $options: 'i' };
        }
        // Sort by pinned (descending), then by updatedAt (descending)
        return await ChatSession_1.ChatSession.find(query).sort({ pinned: -1, updatedAt: -1 });
    }
    /**
     * Toggles the pinned status of a session.
     */
    async togglePinSession(sessionId) {
        const session = await ChatSession_1.ChatSession.findOne({ sessionId });
        if (!session)
            return false;
        session.pinned = !session.pinned;
        session.updatedAt = new Date();
        await session.save();
        return session.pinned;
    }
}
exports.MemoryService = MemoryService;
exports.memoryService = new MemoryService();
exports.default = exports.memoryService;
//# sourceMappingURL=memory.service.js.map
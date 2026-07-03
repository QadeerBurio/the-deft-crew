import { ChatMessage } from '../models/ChatMessage';
import { ChatSession } from '../models/ChatSession';
import { ConversationMemory } from '../models/ConversationMemory';
import { openaiService } from './openai.service';
import { logger } from '../config/logger';

export interface IMessageContext {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class MemoryService {
  /**
   * Retrieves short-term messages and long-term summary context for prompt feeding.
   */
  public async getConversationContext(
    sessionId: string
  ): Promise<{ historyText: string; summary: string; messages: IMessageContext[] }> {
    // 1. Fetch long-term summary
    const memory = await ConversationMemory.findOne({ sessionId });
    const summary = memory ? memory.summary : '';

    // 2. Fetch last 6 messages
    const chatLogs = await ChatMessage.find({ sessionId })
      .sort({ createdAt: -1 })
      .limit(6);
    
    // Sort chronologically
    const sortedLogs = [...chatLogs].reverse();

    const messages: IMessageContext[] = sortedLogs.map((log) => ({
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
  public async compressContextIfNecessary(sessionId: string): Promise<void> {
    try {
      const msgCount = await ChatMessage.countDocuments({ sessionId });
      if (msgCount <= 8) return;

      // Run asynchronously in the background
      (async () => {
        logger.info(`Running background context compression for session: ${sessionId}`);
        
        // Load all except the last 4 messages (which we preserve as active short-term memory)
        const messages = await ChatMessage.find({ sessionId }).sort({ createdAt: 1 });
        const summaryCandidates = messages.slice(0, -4);
        
        if (summaryCandidates.length === 0) return;

        // Fetch existing summary
        let existingSummary = '';
        const memory = await ConversationMemory.findOne({ sessionId });
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

        const completion = await openaiService.getChatCompletion(
          'You summarize chat logs. Keep it factual and brief.',
          prompt
        );

        const newSummary = completion.reply.trim();

        // Save new summary
        await ConversationMemory.findOneAndUpdate(
          { sessionId },
          { summary: newSummary },
          { upsert: true, new: true }
        );

        logger.info(`Context compressed successfully. New Summary: "${newSummary}"`);
      })();
    } catch (err: any) {
      logger.error('Failed to execute context compression:', err.message);
    }
  }

  /**
   * Generates a short, descriptive 3-5 word title based on the first query.
   */
  public async generateSessionTitle(sessionId: string, firstQuery: string): Promise<string> {
    try {
      const prompt = `Analyze the student query and generate a short, clean, descriptive conversation title (3 to 5 words maximum). Do NOT put quotes or punctuation.
Query: "${firstQuery}"
Title:`;

      const completion = await openaiService.getChatCompletion(
        'You write short, concise conversation titles.',
        prompt
      );

      const title = completion.reply.trim().replace(/["']/g, '');
      
      await ChatSession.findOneAndUpdate({ sessionId }, { title });
      logger.info(`Auto-generated title for session ${sessionId}: "${title}"`);
      return title;
    } catch (err: any) {
      logger.error(`Failed to generate title for session ${sessionId}:`, err.message);
      return 'New Conversation';
    }
  }

  /**
   * Queries and searches user sessions list (supports title queries and pinned priority).
   */
  public async searchSessions(userId: string, searchKey?: string): Promise<any[]> {
    const query: Record<string, any> = { userId, status: 'active' };
    
    if (searchKey) {
      query.title = { $regex: searchKey, $options: 'i' };
    }

    // Sort by pinned (descending), then by updatedAt (descending)
    return await ChatSession.find(query).sort({ pinned: -1, updatedAt: -1 });
  }

  /**
   * Toggles the pinned status of a session.
   */
  public async togglePinSession(sessionId: string): Promise<boolean> {
    const session = await ChatSession.findOne({ sessionId });
    if (!session) return false;

    session.pinned = !session.pinned;
    session.updatedAt = new Date();
    await session.save();
    return session.pinned;
  }
}

export const memoryService = new MemoryService();
export default memoryService;

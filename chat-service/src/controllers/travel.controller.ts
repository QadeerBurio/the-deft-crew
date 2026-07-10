import { Request, Response } from 'express';
import { streamingService } from '../services/streaming.service';
import { TRAVEL_SYSTEM_PROMPT } from '../prompts/travel.prompt';
import { logger } from '../config/logger';

interface TravelStreamBody {
  message: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * POST /api/v1/travel/stream
 * 
 * Stateless streaming endpoint for the Travel AI Assistant.
 * Conversation history is maintained on the client and sent with each request.
 * Only the last 10 messages are accepted to keep token usage predictable.
 */
export const postTravelStream = async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const { message, conversationHistory = [] } = req.body as TravelStreamBody;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message is required.' });
    return;
  }

  const user = (req as any).user;

  try {
    // Setup SSE headers immediately
    streamingService.setupSSEHeaders(res);
    res.write(':\n\n'); // SSE heartbeat comment to open the connection

    // Trim conversation history to last 10 messages for token efficiency
    const trimmedHistory = conversationHistory.slice(-10).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Build system prompt with optional user context
    let systemPrompt = TRAVEL_SYSTEM_PROMPT;
    if (user && !user.isGuest) {
      systemPrompt = `[User Info] Name: ${user.name || 'Traveler'}\n\n` + systemPrompt;
    }

    logger.info(`[Travel Assistant] Streaming response for: "${message.substring(0, 80)}..." | History: ${trimmedHistory.length} msgs`);

    // Stream the response using the existing streaming service
    await streamingService.streamChatCompletion(
      systemPrompt,
      message.trim(),
      trimmedHistory,
      res
    );

    const latency = Date.now() - startTime;
    logger.info(`[Travel Assistant] Stream completed in ${latency}ms`);

  } catch (err: any) {
    logger.error('[Travel Assistant] Streaming error:', err.message);

    // If headers haven't been sent yet, return JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Travel assistant is temporarily unavailable.' });
      return;
    }

    // If streaming has started, send error via SSE
    try {
      res.write(`data: ${JSON.stringify({ error: 'An error occurred. Please try again.' })}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (writeErr) {
      // Connection already closed
    }
    res.end();
  }
};

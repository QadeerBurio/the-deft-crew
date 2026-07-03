import { Response } from 'express';
import { OpenAI } from 'openai';
import { openaiService } from './openai.service';
import { env } from '../config/envValidator';
import { logger } from '../config/logger';

export class StreamingService {
  /**
   * Configures HTTP headers for Server-Sent Events (SSE) streaming.
   */
  public setupSSEHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering for nginx
    res.setHeader('x-no-compression', 'true'); // Bypass express compression middleware
    res.flushHeaders();
  }

  /**
   * Streams chat completions token-by-token using SSE data frames.
   */
  public async streamChatCompletion(
    systemInstruction: string,
    userMessage: string,
    historyMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [],
    res: Response,
    onComplete?: (fullReply: string, tokens: { prompt: number; completion: number }) => Promise<void>
  ): Promise<void> {
    if (!openaiService.openaiClient) {
      res.write(`data: ${JSON.stringify({ error: 'OpenAI API key missing' })}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
      res.end();
      return;
    }

    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemInstruction },
        ...historyMessages.map((m) => ({ role: m.role as any, content: m.content })),
        { role: 'user', content: userMessage },
      ];

      const stream = await openaiService.openaiClient.chat.completions.create({
        model: env.OPENAI_MODEL,
        messages,
        temperature: env.OPENAI_TEMPERATURE,
        max_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
        stream: true,
      });

      let fullText = '';
      
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content || '';
        if (token) {
          fullText += token;
          // Format as standard Server-Sent Event frame
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
          if (typeof (res as any).flush === 'function') {
            (res as any).flush();
          }
        }
      }

      // Signal end of stream
      res.write(`data: [DONE]\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
      
      // Calculate token approximations (standard 4 chars per token rule of thumb for stats fallback)
      const promptChars = systemInstruction.length + userMessage.length + JSON.stringify(historyMessages).length;
      const promptTokens = Math.ceil(promptChars / 4);
      const completionTokens = Math.ceil(fullText.length / 4);

      if (onComplete) {
        await onComplete(fullText, { prompt: promptTokens, completion: completionTokens });
      }
    } catch (err: any) {
      logger.error('Error encountered during SSE streaming:', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message || 'Stream generation failed' })}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    } finally {
      res.end();
    }
  }
}

export const streamingService = new StreamingService();
export default streamingService;

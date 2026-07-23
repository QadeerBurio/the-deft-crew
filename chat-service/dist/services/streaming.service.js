"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamingService = exports.StreamingService = void 0;
const openai_service_1 = require("./openai.service");
const envValidator_1 = require("../config/envValidator");
const logger_1 = require("../config/logger");
class StreamingService {
    /**
     * Configures HTTP headers for Server-Sent Events (SSE) streaming.
     */
    setupSSEHeaders(res) {
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
    async streamChatCompletion(systemInstruction, userMessage, historyMessages = [], res, onComplete) {
        if (!openai_service_1.openaiService.openaiClient) {
            res.write(`data: ${JSON.stringify({ error: 'OpenAI API key missing' })}\n\n`);
            if (typeof res.flush === 'function') {
                res.flush();
            }
            res.end();
            return;
        }
        try {
            const messages = [
                { role: 'system', content: systemInstruction },
                ...historyMessages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: userMessage },
            ];
            const stream = await openai_service_1.openaiService.openaiClient.chat.completions.create({
                model: envValidator_1.env.OPENAI_MODEL,
                messages,
                temperature: envValidator_1.env.OPENAI_TEMPERATURE,
                max_tokens: envValidator_1.env.OPENAI_MAX_OUTPUT_TOKENS,
                stream: true,
            });
            let fullText = '';
            for await (const chunk of stream) {
                const token = chunk.choices[0]?.delta?.content || '';
                if (token) {
                    fullText += token;
                    // Format as standard Server-Sent Event frame
                    res.write(`data: ${JSON.stringify({ token })}\n\n`);
                    if (typeof res.flush === 'function') {
                        res.flush();
                    }
                }
            }
            // Signal end of stream
            res.write(`data: [DONE]\n\n`);
            if (typeof res.flush === 'function') {
                res.flush();
            }
            // Calculate token approximations (standard 4 chars per token rule of thumb for stats fallback)
            const promptChars = systemInstruction.length + userMessage.length + JSON.stringify(historyMessages).length;
            const promptTokens = Math.ceil(promptChars / 4);
            const completionTokens = Math.ceil(fullText.length / 4);
            if (onComplete) {
                await onComplete(fullText, { prompt: promptTokens, completion: completionTokens });
            }
        }
        catch (err) {
            logger_1.logger.error('Error encountered during SSE streaming:', err.message);
            res.write(`data: ${JSON.stringify({ error: err.message || 'Stream generation failed' })}\n\n`);
            if (typeof res.flush === 'function') {
                res.flush();
            }
        }
        finally {
            res.end();
        }
    }
}
exports.StreamingService = StreamingService;
exports.streamingService = new StreamingService();
exports.default = exports.streamingService;
//# sourceMappingURL=streaming.service.js.map
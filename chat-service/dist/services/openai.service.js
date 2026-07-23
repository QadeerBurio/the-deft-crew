"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openaiService = exports.OpenAIService = void 0;
const openai_1 = require("openai");
const envValidator_1 = require("../config/envValidator");
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../config/logger");
const toolRegistry_1 = require("./toolRegistry");
class OpenAIService {
    openaiClient; // Changed to public for streaming access
    constructor() {
        if (envValidator_1.env.OPENAI_API_KEY) {
            this.openaiClient = new openai_1.OpenAI({
                apiKey: envValidator_1.env.OPENAI_API_KEY,
                timeout: 25000, // 25s timeout for resilient production handling
                maxRetries: 0,
            });
        }
    }
    /**
     * Dispatches chat request to OpenAI Chat Completions API with tool calling support.
     */
    async getChatCompletion(systemInstruction, userMessage, historyMessages = []) {
        if (!envValidator_1.env.OPENAI_API_KEY || !this.openaiClient) {
            throw new ApiError_1.ApiError(503, 'OpenAI API service is not configured. Missing API key.');
        }
        try {
            const startTime = Date.now();
            logger_1.logger.info(`Sending request to OpenAI using model: ${envValidator_1.env.OPENAI_MODEL}`);
            // Compile message array
            const messages = [
                { role: 'system', content: systemInstruction },
                ...historyMessages.map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: userMessage },
            ];
            // Step 1: Initial call to detect if tool calling is required
            let response = await this.openaiClient.chat.completions.create({
                model: envValidator_1.env.OPENAI_MODEL,
                messages,
                temperature: envValidator_1.env.OPENAI_TEMPERATURE,
                max_tokens: envValidator_1.env.OPENAI_MAX_OUTPUT_TOKENS,
                tools: toolRegistry_1.toolDefinitions,
            });
            let assistantMessage = response.choices[0]?.message;
            // Step 2: Loop tool executions if requested by LLM
            if (assistantMessage && assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                logger_1.logger.info(`LLM requested ${assistantMessage.tool_calls.length} tool execution(s).`);
                // Append assistant's tool calls request to thread
                messages.push(assistantMessage);
                for (const toolCall of assistantMessage.tool_calls) {
                    const tc = toolCall;
                    const functionName = tc.function.name;
                    const functionArgs = JSON.parse(tc.function.arguments || '{}');
                    logger_1.logger.info(`Running tool: [${functionName}] with args:`, JSON.stringify(functionArgs));
                    let toolResult = '';
                    const handler = toolRegistry_1.toolHandlers[functionName];
                    if (handler) {
                        try {
                            const resultDocs = await handler(functionArgs);
                            toolResult = JSON.stringify(resultDocs);
                        }
                        catch (err) {
                            logger_1.logger.error(`Error in tool handler [${functionName}]:`, err.message);
                            toolResult = JSON.stringify({ error: err.message });
                        }
                    }
                    else {
                        logger_1.logger.warn(`No handler registered for tool: ${functionName}`);
                        toolResult = JSON.stringify({ error: 'Tool not found' });
                    }
                    // Append tool response
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        name: functionName,
                        content: toolResult,
                    });
                }
                // Fetch final completion incorporating tool results
                response = await this.openaiClient.chat.completions.create({
                    model: envValidator_1.env.OPENAI_MODEL,
                    messages,
                    temperature: envValidator_1.env.OPENAI_TEMPERATURE,
                    max_tokens: envValidator_1.env.OPENAI_MAX_OUTPUT_TOKENS,
                });
                assistantMessage = response.choices[0]?.message;
            }
            const latencyMs = Date.now() - startTime;
            const reply = assistantMessage?.content || '';
            const usage = {
                inputTokens: response.usage?.prompt_tokens || 0,
                outputTokens: response.usage?.completion_tokens || 0,
                totalTokens: response.usage?.total_tokens || 0,
            };
            return {
                reply,
                latencyMs,
                usage,
                modelUsed: response.model || envValidator_1.env.OPENAI_MODEL,
            };
        }
        catch (error) {
            logger_1.logger.error('OpenAI Request Failure:', {
                message: error.message,
                status: error.status,
                code: error.code,
            });
            // Handle common OpenAI API errors
            if (error.status === 401) {
                throw new ApiError_1.ApiError(401, 'Authentication failed with OpenAI. Invalid API key.');
            }
            if (error.status === 429) {
                throw new ApiError_1.ApiError(429, 'OpenAI rate limits exceeded. Please wait a moment and try again.');
            }
            if (error.code === 'ETIMEOUT' || error.status === 504) {
                throw new ApiError_1.ApiError(504, 'Request to OpenAI timed out. Please try again.');
            }
            throw new ApiError_1.ApiError(error.status || 500, error.message || 'An unexpected error occurred during AI processing.');
        }
    }
    /**
     * Generates vector embeddings for single or multiple text blocks.
     */
    async getEmbeddings(input) {
        if (!envValidator_1.env.OPENAI_API_KEY || !this.openaiClient) {
            throw new ApiError_1.ApiError(503, 'OpenAI API service is not configured. Missing API key.');
        }
        try {
            const response = await this.openaiClient.embeddings.create({
                model: envValidator_1.env.OPENAI_EMBEDDING_MODEL,
                input,
            });
            return response.data.map((item) => item.embedding);
        }
        catch (error) {
            logger_1.logger.error('OpenAI Embeddings Generation Failure:', {
                message: error.message,
                status: error.status,
                code: error.code,
            });
            if (error.status === 401) {
                throw new ApiError_1.ApiError(401, 'Authentication failed with OpenAI. Invalid API key.');
            }
            if (error.status === 429) {
                throw new ApiError_1.ApiError(429, 'OpenAI rate limits exceeded. Please wait a moment and try again.');
            }
            throw new ApiError_1.ApiError(error.status || 500, error.message || 'An unexpected error occurred during embedding generation.');
        }
    }
}
exports.OpenAIService = OpenAIService;
exports.openaiService = new OpenAIService();
exports.default = exports.openaiService;
//# sourceMappingURL=openai.service.js.map
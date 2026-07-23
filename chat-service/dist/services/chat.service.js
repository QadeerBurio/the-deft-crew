"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatService = exports.ChatService = void 0;
const prompt_service_1 = require("./prompt.service");
const openai_service_1 = require("./openai.service");
class ChatService {
    /**
     * Processes a incoming user chat message, composes prompts and requests completion.
     */
    async handleUserMessage(message) {
        // 1. Compose dynamic system instruction guidelines
        const systemInstruction = prompt_service_1.promptService.getSystemInstructions();
        // 2. Fetch completion output from OpenAI
        return openai_service_1.openaiService.getChatCompletion(systemInstruction, message);
    }
}
exports.ChatService = ChatService;
exports.chatService = new ChatService();
exports.default = exports.chatService;
//# sourceMappingURL=chat.service.js.map
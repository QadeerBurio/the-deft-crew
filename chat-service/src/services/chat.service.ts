import { promptService } from './prompt.service';
import { openaiService, ChatResponse } from './openai.service';

export class ChatService {
  /**
   * Processes a incoming user chat message, composes prompts and requests completion.
   */
  public async handleUserMessage(message: string): Promise<ChatResponse> {
    // 1. Compose dynamic system instruction guidelines
    const systemInstruction = promptService.getSystemInstructions();
    
    // 2. Fetch completion output from OpenAI
    return openaiService.getChatCompletion(systemInstruction, message);
  }
}

export const chatService = new ChatService();
export default chatService;

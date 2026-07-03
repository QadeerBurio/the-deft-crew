import { SYSTEM_PROMPT } from '../prompts/system.prompt';
import { DEVELOPER_PROMPT } from '../prompts/developer.prompt';
import { SAFETY_PROMPT } from '../prompts/safety.prompt';

export class PromptService {
  /**
   * Dynamically constructs the system instructions by composing individual prompt segments.
   */
  public getSystemInstructions(context?: string): string {
    let instructions = `
${SYSTEM_PROMPT}

${DEVELOPER_PROMPT}

${SAFETY_PROMPT}
`.trim();

    if (context) {
      instructions += `\n\n--- VERIFIED CONTEXT ---
Use ONLY the following facts to construct your reply. Prioritize this knowledge. If these details do not contain the answer to the user's question, clearly state that you do not possess that information. Do NOT guess or invent facts.

${context}
--- END OF VERIFIED CONTEXT ---`;
    }

    return instructions;
  }
}

export const promptService = new PromptService();
export default promptService;

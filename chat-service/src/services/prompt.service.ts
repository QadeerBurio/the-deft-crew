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
Below is the verified data available from the TDC database. Prioritize this information to construct your response. If the database details do not contain the specific answer to the user's question, guide the user to the appropriate section of the TDC mobile app to check for live updates, rather than inventing facts.

${context}
--- END OF VERIFIED CONTEXT ---`;
    }

    return instructions;
  }
}

export const promptService = new PromptService();
export default promptService;

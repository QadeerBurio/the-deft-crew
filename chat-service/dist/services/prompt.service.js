"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptService = exports.PromptService = void 0;
const system_prompt_1 = require("../prompts/system.prompt");
const developer_prompt_1 = require("../prompts/developer.prompt");
const safety_prompt_1 = require("../prompts/safety.prompt");
class PromptService {
    /**
     * Dynamically constructs the system instructions by composing individual prompt segments.
     */
    getSystemInstructions(context) {
        let instructions = `
${system_prompt_1.SYSTEM_PROMPT}

${developer_prompt_1.DEVELOPER_PROMPT}

${safety_prompt_1.SAFETY_PROMPT}
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
exports.PromptService = PromptService;
exports.promptService = new PromptService();
exports.default = exports.promptService;
//# sourceMappingURL=prompt.service.js.map
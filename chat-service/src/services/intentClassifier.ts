import { openaiService } from './openai.service';
import { logger } from '../config/logger';

export class IntentClassifier {
  private readonly validIntents = [
    'Search Scholarship',
    'Search Job',
    'Search Discount',
    'Search Event',
    'Search University',
    'Greeting',
    'General Navigation',
    'Help',
    'Unknown',
  ];

  /**
   * Classifies user query into one of the standard intent labels.
   */
  public async classifyIntent(message: string): Promise<string> {
    try {
      const prompt = `Classify the following user message into exactly one of these categories:
${this.validIntents.map((i) => `- ${i}`).join('\n')}

Rules:
- Respond with ONLY the exact category name.
- Do NOT include any other text or punctuation.

Message: "${message}"
Category:`;

      const completion = await openaiService.getChatCompletion(
        'You are an expert intent classification model. Return only the exact category name.',
        prompt
      );

      const detectedLabel = completion.reply.trim().replace(/["']/g, '');

      // Match against valid intents or fall back to Unknown
      const finalIntent = this.validIntents.find(
        (intent) => intent.toLowerCase() === detectedLabel.toLowerCase()
      ) || 'Unknown';

      logger.info(`Intent classification result for query "${message}": [${finalIntent}]`);
      return finalIntent;
    } catch (err: any) {
      logger.error('Intent classification failed, falling back to Unknown:', err.message);
      return 'Unknown';
    }
  }
}

export const intentClassifier = new IntentClassifier();
export default intentClassifier;

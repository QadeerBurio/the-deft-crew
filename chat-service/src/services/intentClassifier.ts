import { logger } from '../config/logger';

export class IntentClassifier {

  /**
   * Classifies user query into one of the standard intent labels.
   */
  public async classifyIntent(message: string): Promise<string> {
    try {
      const text = message.trim().toLowerCase();
      
      // Fast, millisecond-level local classification checks

      // Greetings
      if (/^(hi|hello|hey|hola|salam|assalam o alaikum|heyy|greetings|good morning|good afternoon|good evening|howdy|hi there)$/i.test(text) || text.length < 4) {
        return 'Greeting';
      }

      // Founder / Leadership queries
      if (/\b(majid|majid shah|founder|co-founder|cofounder|head of marketing|who founded|leadership|ceo|owner)\b/i.test(text)) {
        return 'TDC Knowledge';
      }

      // TDC Company knowledge queries
      if (/\b(what is tdc|what is the deft crew|tell me about tdc|tell me about the deft crew|about tdc|about the deft crew|tdc services|deft crew services|what does tdc do|what does the deft crew do|tdc mission|tdc vision|tdc partners|university partners|university partnerships|iobm|szabist|ziauddin|indus university|denning)\b/i.test(text)) {
        return 'TDC Knowledge';
      }

      // Service queries
      if (/\b(services|digital marketing|performance marketing|seo|branding|web development|app development|ai solution|automation|consulting|workflow)\b/i.test(text)) {
        return 'TDC Knowledge';
      }

      // Jobs & Internships
      if (/\b(job|internship|intern|work|career|hiring|vacancy|employment|placement|openings|opportunity|opportunities)\b/i.test(text)) {
        return 'Search Job';
      }

      // Scholarships
      if (/\b(scholarship|financial aid|funding|bursary|hec scholarship|grant|stipend|fully funded)\b/i.test(text)) {
        return 'Search Scholarship';
      }

      // Discounts & Offers
      if (/\b(discount|promo|deal|coupon|voucher|offer|off|sale|brand deal|student deal)\b/i.test(text)) {
        return 'Search Discount';
      }

      // Events
      if (/\b(event|seminar|workshop|meetup|webinar|symposium|conference|hackathon|competition|mixer)\b/i.test(text)) {
        return 'Search Event';
      }

      // Universities
      if (/\b(university|college|school|admission|campus|degree|apply to)\b/i.test(text)) {
        return 'Search University';
      }

      // Resume / Templates
      if (/\b(resume|cv|template|ats|cover letter|portfolio|curriculum vitae)\b/i.test(text)) {
        return 'Search Template';
      }

      // Travel packages
      if (/\b(travel|tour|package|trip|skardu|hunza|adventure|vacation)\b/i.test(text)) {
        return 'Search Package';
      }

      // Help
      if (/^(help|support|info|information|guide|menu|what can you do|how do you work|what can i ask)$/i.test(text)) {
        return 'Help';
      }

      // Default to Unknown — LLM will answer with grounded system prompt
      return 'Unknown';
    } catch (err: any) {
      logger.error('Intent classification failed, falling back to Unknown:', err.message);
      return 'Unknown';
    }
  }
}

export const intentClassifier = new IntentClassifier();
export default intentClassifier;

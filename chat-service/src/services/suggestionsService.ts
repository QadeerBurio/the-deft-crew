import { logger } from '../config/logger';

export class SuggestionsService {
  /**
   * Generates dynamic contextual follow-up questions according to conversation history.
   */
  public getDynamicSuggestions(historyText?: string): string[] {
    try {
      const text = (historyText || '').toLowerCase();

      // Category matches
      if (text.includes('template') || text.includes('cv') || text.includes('resume')) {
        return [
          'Find ATS Resume Templates',
          'Show Apex Resume details',
          'How to make a modern CV?',
        ];
      }

      if (text.includes('job') || text.includes('intern') || text.includes('career') || text.includes('work')) {
        return [
          'Find internships',
          'Jobs in Karachi',
          'Remote jobs',
          'Latest openings',
        ];
      }

      if (text.includes('discount') || text.includes('offer') || text.includes('deal') || text.includes('eatery')) {
        return [
          'Restaurants',
          'Fashion',
          'Electronics',
          'Nearby discounts',
        ];
      }

      if (text.includes('event') || text.includes('competition') || text.includes('hackathon') || text.includes('iqra')) {
        return [
          'National Coding Competition details',
          'Show hackathons near me',
          'Mixers in Iqra University',
        ];
      }

      if (text.includes('scholarship') || text.includes('grant') || text.includes('financial')) {
        return [
          'Study in Turkey',
          'Fully funded',
          'Masters',
          'PhD',
        ];
      }

      if (text.includes('travel') || text.includes('package') || text.includes('tour') || text.includes('skardu')) {
        return [
          'Show travel packages',
          'Skardu Calling details',
          'Cheapest group student tours',
        ];
      }

      // Default landing state suggestions
      return [
        'Latest Brand Discounts',
        'Find Student Internships',
        'ATS Resume Templates',
        'Nearby Campus Events',
      ];
    } catch (err: any) {
      logger.error('Failed to generate suggestions:', err.message);
      return ['Latest Brand Discounts', 'Find Student Internships', 'ATS Resume Templates'];
    }
  }
}

export const suggestionsService = new SuggestionsService();
export default suggestionsService;

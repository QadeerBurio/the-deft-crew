"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.suggestionsService = exports.SuggestionsService = void 0;
const logger_1 = require("../config/logger");
class SuggestionsService {
    /**
     * Generates dynamic contextual follow-up questions according to conversation history.
     */
    getDynamicSuggestions(historyText) {
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
        }
        catch (err) {
            logger_1.logger.error('Failed to generate suggestions:', err.message);
            return ['Latest Brand Discounts', 'Find Student Internships', 'ATS Resume Templates'];
        }
    }
}
exports.SuggestionsService = SuggestionsService;
exports.suggestionsService = new SuggestionsService();
exports.default = exports.suggestionsService;
//# sourceMappingURL=suggestionsService.js.map
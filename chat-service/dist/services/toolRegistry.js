"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolHandlers = exports.toolDefinitions = void 0;
const KnowledgeDocument_1 = require("../models/KnowledgeDocument");
const logger_1 = require("../config/logger");
// Standardized lookup helper against local synchronized Knowledge base
async function searchCollection(category, query) {
    const filter = { category, status: 'published' };
    try {
        if (query) {
            // Try text score matching
            const results = await KnowledgeDocument_1.KnowledgeDocument.find({ ...filter, $text: { $search: query } }, { score: { $meta: 'textScore' } })
                .sort({ score: { $meta: 'textScore' } })
                .limit(5);
            if (results.length > 0)
                return results;
            // Fallback to regex matches
            return await KnowledgeDocument_1.KnowledgeDocument.find({
                ...filter,
                $or: [
                    { title: { $regex: query, $options: 'i' } },
                    { content: { $regex: query, $options: 'i' } },
                ],
            }).limit(5);
        }
        // Default: fetch latest items
        return await KnowledgeDocument_1.KnowledgeDocument.find(filter).sort({ updatedAt: -1 }).limit(5);
    }
    catch (err) {
        logger_1.logger.error(`Database tool search failed for category ${category}:`, err.message);
        return [];
    }
}
exports.toolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'searchScholarships',
            description: 'Search for active student scholarships, grants, financial aids, or academic exchange programs by query keywords.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword query (e.g. "Excellence", "GPA 3.8", "Exchange")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchJobs',
            description: 'Search for active career listings, internships, full-time/part-time jobs, and work placements.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword query (e.g. "React Developer", "Marketing Intern", "Unpaid")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchOffers',
            description: 'Search for active student discounts, brand promo deals, restaurants, clothing shops, or cafe discounts.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Brand or category keywords (e.g. "Food", "MS Eatery", "15%")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchEvents',
            description: 'Search for local campus meetups, student mixers, hackathons, coding competitions, or university seminars.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Event title, organizer, or city keywords (e.g. "Coding", "Iqra", "Karachi")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchUniversities',
            description: 'Search for verified academic institutions and colleges registered on the TDC platform.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'University name keywords (e.g. "Dow University", "Iqra")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchTemplates',
            description: 'Search for professional ATS-friendly resume layouts and template designs in the catalog.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Template category or layout keywords (e.g. "Modern", "Creative", "Aero")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchPackages',
            description: 'Search for student-friendly adventure tours, local group packages, or travel deals.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Destination or category keywords (e.g. "Skardu", "Pakistan Tours")' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'searchTDCKnowledge',
            description: 'Search TDC company knowledge base for information about The Deft Crew, its founder Majid Shah, services offered, university partnerships, and the student ecosystem.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Knowledge query (e.g. "Majid Shah", "TDC services", "university partnerships", "IoBM")' },
                },
            },
        },
    },
];
exports.toolHandlers = {
    searchScholarships: async (args) => searchCollection('scholarships', args.query),
    searchJobs: async (args) => searchCollection('jobs', args.query),
    searchOffers: async (args) => searchCollection('offers', args.query),
    searchEvents: async (args) => searchCollection('events', args.query),
    searchUniversities: async (args) => searchCollection('universities', args.query),
    searchTemplates: async (args) => searchCollection('templates', args.query),
    searchPackages: async (args) => searchCollection('packages', args.query),
    searchTDCKnowledge: async (args) => searchCollection('tdc_knowledge', args.query),
};
//# sourceMappingURL=toolRegistry.js.map
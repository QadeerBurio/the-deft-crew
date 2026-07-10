import { KnowledgeDocument } from '../models/KnowledgeDocument';
import { logger } from '../config/logger';

// Standardized lookup helper against local synchronized Knowledge base
async function searchCollection(category: string, query?: string): Promise<any[]> {
  const filter: any = { category, status: 'published' };
  
  try {
    if (query) {
      // Try text score matching
      const results = await KnowledgeDocument.find(
        { ...filter, $text: { $search: query } },
        { score: { $meta: 'textScore' } }
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(5);
        
      if (results.length > 0) return results;
      
      // Fallback to regex matches
      return await KnowledgeDocument.find({
        ...filter,
        $or: [
          { title: { $regex: query, $options: 'i' } },
          { content: { $regex: query, $options: 'i' } },
        ],
      }).limit(5);
    }
    
    // Default: fetch latest items
    return await KnowledgeDocument.find(filter).sort({ updatedAt: -1 }).limit(5);
  } catch (err: any) {
    logger.error(`Database tool search failed for category ${category}:`, err.message);
    return [];
  }
}

export const toolDefinitions = [
  {
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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
    type: 'function' as const,
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

export const toolHandlers: Record<string, (args: any) => Promise<any>> = {
  searchScholarships: async (args) => searchCollection('scholarships', args.query),
  searchJobs: async (args) => searchCollection('jobs', args.query),
  searchOffers: async (args) => searchCollection('offers', args.query),
  searchEvents: async (args) => searchCollection('events', args.query),
  searchUniversities: async (args) => searchCollection('universities', args.query),
  searchTemplates: async (args) => searchCollection('templates', args.query),
  searchPackages: async (args) => searchCollection('packages', args.query),
  searchTDCKnowledge: async (args) => searchCollection('tdc_knowledge', args.query),
};

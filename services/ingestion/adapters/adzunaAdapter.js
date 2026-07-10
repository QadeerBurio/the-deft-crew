// services/ingestion/adapters/adzunaAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

const SEARCH_KEYWORDS = [
  'software engineer', 'web developer', 'internship', 
  'intern', 'graduate trainee', 'management trainee', 
  'marketing sales', 'finance accounting', 'human resources', 
  'customer support', 'graphic designer', 'it support',
  'engineering intern', 'business intern'
];

let keywordIndex = 0;

class AdzunaAdapter extends BaseAdapter {
  constructor() {
    super('adzuna');
  }

  async fetchJobs() {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;

    if (!appId || !appKey) {
      console.warn('⚠️  [Ingestion] Adzuna skipped — ADZUNA_APP_ID or ADZUNA_APP_KEY is not configured');
      return [];
    }

    // Rotate keywords to ensure multi-industry coverage
    const query = SEARCH_KEYWORDS[keywordIndex % SEARCH_KEYWORDS.length];
    keywordIndex++;

    console.log(`🔌 [Ingestion] Adzuna adapter fetching jobs for query: "${query}"...`);
    
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/pk/search/1`;
      const response = await axios.get(url, {
        params: {
          app_id: appId,
          app_key: appKey,
          results_per_page: 15,
          what: query
        },
        timeout: 10000
      });

      if (!response.data || !Array.isArray(response.data.results)) {
        throw new Error('Invalid response structure from Adzuna');
      }

      return response.data.results.map(j => this.normalize(j));
    } catch (err) {
      console.error(`❌ [Ingestion] Adzuna API call failed:`, err.message);
      return [];
    }
  }

  normalize(raw) {
    const desc = this.stripHtml(raw.description || '');
    const location = raw.location?.display_name || 'Pakistan';
    const companyName = raw.company?.display_name || 'Confidential Company';
    const category = this.mapCategory(raw.category?.label || '');
    const empType = this.mapEmploymentType(raw.contract_time || '');

    const extractedSkills = this.extractSkillsFromText(desc);

    return {
      title:           raw.title || 'Job Opportunity',
      department:      raw.category?.label || 'General',
      category:        category,
      location:        location,
      locationType:    raw.title?.toLowerCase().includes('remote') ? 'Remote' : 'On-site',
      type:            empType,
      salary:          raw.salary_min ? `${raw.salary_min} - ${raw.salary_max || ''} / Year` : 'Competitive',
      salaryMin:       raw.salary_min || 0,
      salaryMax:       raw.salary_max || 0,
      currency:        'PKR',
      email:           'apply@adzuna-aggregator.com',
      description:     desc,
      requirements:    [],
      responsibilities: [],
      benefits:        [],
      experienceLevel: 'Mid Level',
      skills:          extractedSkills.slice(0, 10),
      active:          true,
      companyName:     companyName,
      companyLogo:     '',
      companyWebsite:  '',
      source:          'adzuna',
      externalId:      raw.id.toString(),
      externalUrl:     raw.redirect_url,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = AdzunaAdapter;

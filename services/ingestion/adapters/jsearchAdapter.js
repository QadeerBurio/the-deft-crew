// services/ingestion/adapters/jsearchAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

const ROTATING_QUERIES = [
  'accounting finance banking Karachi Lahore',
  'nursing healthcare pharmacy Pakistan',
  'mechanical electrical civil engineer Pakistan',
  'customer support call center sales Lahore',
  'human resources recruiter Islamabad',
  'graphic designer creative media marketing',
  'supply chain logistics textile management',
  'apprentice fellowship graduate trainee Pakistan',
  'retail store manager sales associate Pakistan',
  'school teacher lecturer education Pakistan',
  'administration office assistant secretary Karachi',
  'hospitality hotel manager chef tourism Pakistan',
  'aviation pilot cabin crew aerospace Pakistan',
  'journalist news editor writer media Pakistan',
  'agricultural specialist agronomist farming Pakistan',
  'lawyer legal counsel advisor advocate Pakistan'
];

let queryIndex = 0;

class JSearchAdapter extends BaseAdapter {
  constructor() {
    super('jSearch');
  }

  async fetchJobs() {
    const apiKey = process.env.RAPIDAPI_KEY || process.env.JSEARCH_API_KEY;
    if (!apiKey) {
      console.warn('⚠️  [Ingestion] JSearch skipped — RAPIDAPI_KEY is not configured');
      return [];
    }

    const query = ROTATING_QUERIES[queryIndex % ROTATING_QUERIES.length];
    queryIndex++;

    console.log(`🔌 [Ingestion] JSearch adapter fetching jobs for query: "${query}"...`);
    const options = {
      method: 'GET',
      url: 'https://jsearch.p.rapidapi.com/search',
      params: {
        query: query,
        page: '1',
        num_pages: '1'
      },
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': 'jsearch.p.rapidapi.com'
      },
      timeout: 10000
    };

    const response = await axios.request(options);
    if (!response.data || !Array.isArray(response.data.data)) {
      throw new Error('Invalid response structure from JSearch');
    }

    return response.data.data.map(j => this.normalize(j));
  }

  normalize(raw) {
    const city = raw.job_city || '';
    const country = raw.job_country || '';
    const location = [city, country].filter(Boolean).join(', ') || 'Remote';
    const isRemote = raw.job_is_remote || false;

    let skills = [];
    if (Array.isArray(raw.job_required_skills)) {
      skills = raw.job_required_skills;
    } else if (raw.job_highlights?.Qualifications) {
      skills = raw.job_highlights.Qualifications.slice(0, 5);
    }

    // Supplement skills list from description text
    const extractedSkills = this.extractSkillsFromText(raw.job_description);
    const combinedSkills = [...new Set([...skills, ...extractedSkills])];

    return {
      title:           raw.job_title || 'Software Developer',
      department:      raw.job_category || 'Technology',
      category:        this.mapCategory(raw.job_category || 'Technology'),
      location:        location,
      locationType:    isRemote ? 'Remote' : 'On-site',
      type:            this.mapEmploymentType(raw.job_employment_type),
      salary:          raw.job_salary_period ? `${raw.job_min_salary || ''} - ${raw.job_max_salary || ''} / ${raw.job_salary_period}` : 'Competitive',
      salaryMin:       raw.job_min_salary || 0,
      salaryMax:       raw.job_max_salary || 0,
      currency:        raw.job_salary_currency || 'USD',
      email:           'apply@jsearch-aggregator.com',
      description:     raw.job_description || 'No description listed.',
      requirements:    raw.job_highlights?.Qualifications || [],
      responsibilities: raw.job_highlights?.Responsibilities || [],
      benefits:        raw.job_highlights?.Benefits || [],
      experienceLevel: raw.job_required_experience?.required_experience_in_months >= 36 ? 'Senior Level' : 'Mid Level',
      skills:          combinedSkills.slice(0, 10),
      active:          true,
      companyName:     raw.employer_name || 'Employer',
      companyLogo:     raw.employer_logo || '',
      companyWebsite:  raw.employer_website || '',
      source:          'jSearch',
      externalId:      raw.job_id,
      externalUrl:     raw.job_apply_link || raw.job_google_link,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = JSearchAdapter;

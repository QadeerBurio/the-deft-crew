// services/ingestion/adapters/arbeitnowAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

class ArbeitnowAdapter extends BaseAdapter {
  constructor() {
    super('arbeitnow');
  }

  async fetchJobs() {
    console.log('🔌 [Ingestion] Arbeitnow adapter fetching jobs...');
    try {
      const url = 'https://www.arbeitnow.com/api/job-board-api';
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data || !Array.isArray(response.data.data)) {
        throw new Error('Invalid response structure from Arbeitnow');
      }

      // Limit to top 15 results to manage DB load and api response limits
      const jobs = response.data.data.slice(0, 15);
      return jobs.map(j => this.normalize(j));
    } catch (err) {
      console.error('❌ [Ingestion] Arbeitnow failed:', err.message);
      return [];
    }
  }

  normalize(raw) {
    const desc = this.stripHtml(raw.description || '');
    const location = raw.location || 'Germany';
    const companyName = raw.company_name || 'Employer';
    const rawCategory = Array.isArray(raw.tags) && raw.tags.length > 0 ? raw.tags[0] : 'General';
    const category = this.mapCategory(rawCategory);

    let empType = 'Full-time';
    if (Array.isArray(raw.job_types) && raw.job_types.length > 0) {
      empType = this.mapEmploymentType(raw.job_types[0]);
    }

    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const extractedSkills = this.extractSkillsFromText(desc);
    const combinedSkills = [...new Set([...tags, ...extractedSkills])];

    return {
      title:           raw.title || 'Job Opportunity',
      department:      rawCategory,
      category:        category,
      location:        location,
      locationType:    raw.remote ? 'Remote' : 'On-site',
      type:            empType,
      salary:          'Competitive',
      salaryMin:       0,
      salaryMax:       0,
      currency:        'EUR',
      email:           'apply@arbeitnow-aggregator.com',
      description:     desc,
      requirements:    [],
      responsibilities: [],
      benefits:        [],
      experienceLevel: 'Mid Level',
      skills:          combinedSkills.slice(0, 10),
      active:          true,
      companyName:     companyName,
      companyLogo:     '',
      companyWebsite:  '',
      source:          'arbeitnow',
      externalId:      raw.slug,
      externalUrl:     raw.url,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = ArbeitnowAdapter;

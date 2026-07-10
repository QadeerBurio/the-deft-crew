// services/ingestion/adapters/remotiveAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

class RemotiveAdapter extends BaseAdapter {
  constructor() {
    super('remotive');
  }

  async fetchJobs() {
    console.log('🔌 [Ingestion] Remotive adapter fetching jobs...');
    const url = 'https://remotive.com/api/remote-jobs?limit=15';
    const response = await axios.get(url, { timeout: 10000 });
    
    if (!response.data || !Array.isArray(response.data.jobs)) {
      throw new Error('Invalid response structure from Remotive');
    }
    
    return response.data.jobs.map(j => this.normalize(j));
  }

  normalize(raw) {
    const rawSkills = Array.isArray(raw.tags) ? raw.tags : [];
    const descriptionText = this.stripHtml(raw.description);
    
    // Supplement skills list by scanning description text
    const extractedSkills = this.extractSkillsFromText(descriptionText);
    const combinedSkills = [...new Set([...rawSkills, ...extractedSkills])];

    return {
      title:           raw.title || 'Remote Developer',
      department:      raw.category || 'Engineering',
      category:        this.mapCategory(raw.category),
      location:        raw.candidate_required_location || 'Remote',
      locationType:    'Remote',
      type:            this.mapEmploymentType(raw.job_type),
      salary:          raw.salary || 'Competitive',
      salaryMin:       0,
      salaryMax:       0,
      currency:        'USD',
      email:           'recruiting@remotive.com',
      description:     descriptionText,
      requirements:    [],
      responsibilities: [],
      benefits:        [],
      experienceLevel: 'Mid Level',
      skills:          combinedSkills.slice(0, 10),
      active:          true,
      companyName:     raw.company_name || 'Remote Company',
      companyLogo:     raw.company_logo || '',
      companyWebsite:  '',
      source:          'remotive',
      externalId:      raw.id.toString(),
      externalUrl:     raw.url,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = RemotiveAdapter;

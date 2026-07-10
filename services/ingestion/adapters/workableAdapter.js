// services/ingestion/adapters/workableAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

const WORKABLE_COMPANIES = [
  { subdomain: 'devsinc-17', name: 'Devsinc' },
  { subdomain: 'abbott-laboratories', name: 'Abbott Laboratories' },
  { subdomain: 'honda', name: 'Honda' }
];

class WorkableAdapter extends BaseAdapter {
  constructor() {
    super('workable');
  }

  async fetchJobs() {
    console.log('🔌 [Ingestion] Workable adapter fetching jobs via widget API...');
    const allNormalizedJobs = [];

    for (const company of WORKABLE_COMPANIES) {
      try {
        console.log(`   └─ Fetching jobs for ${company.name} (${company.subdomain})`);
        const url = `https://apply.workable.com/api/v1/widget/accounts/${company.subdomain}?details=true`;
        const response = await axios.get(url, {
          timeout: 12000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        if (!response.data || !Array.isArray(response.data.jobs)) {
          console.warn(`⚠️  [Ingestion] Invalid response from Workable widget for company ${company.name}`);
          continue;
        }

        let normalized = response.data.jobs.map(job => this.normalize(job, company.name));
        if (normalized.length > 40) {
          console.log(`   └─ Ingesting top 40 of ${normalized.length} jobs for ${company.name} to maintain category balance.`);
          normalized = normalized.slice(0, 40);
        }
        allNormalizedJobs.push(...normalized);
      } catch (err) {
        console.error(`❌ [Ingestion] Workable failed for company ${company.name}:`, err.message);
      }
    }

    return allNormalizedJobs;
  }

  normalize(raw, companyName) {
    const desc = raw.description || '';
    const reqs = raw.requirements || '';
    const benefits = raw.benefits || '';

    const cleanDescription = this.stripHtml([desc, reqs, benefits].filter(Boolean).join('\n'));
    const extractedSkills = this.extractSkillsFromText(cleanDescription);

    const city = raw.location?.city || '';
    const country = raw.location?.country || 'Pakistan';
    const location = [city, country].filter(Boolean).join(', ');

    const isRemote = raw.location?.telecommuting || false;

    return {
      title:           raw.title || 'Software Engineer',
      department:      raw.department || 'Engineering',
      category:        this.mapCategory(raw.department || 'Technology'),
      location:        location,
      locationType:    isRemote ? 'Remote' : 'On-site',
      type:            'Full-time', // Workable lists standard openings
      salary:          'Competitive',
      salaryMin:       0,
      salaryMax:       0,
      currency:        'PKR',
      email:           'recruiting@deftcrew.com',
      description:     cleanDescription,
      requirements:    reqs ? [this.stripHtml(reqs)] : [],
      responsibilities: [],
      benefits:        benefits ? [this.stripHtml(benefits)] : [],
      experienceLevel: raw.title?.toLowerCase().includes('senior') || raw.title?.toLowerCase().includes('lead') ? 'Senior Level' : 'Mid Level',
      skills:          extractedSkills.slice(0, 10),
      active:          true,
      companyName:     companyName,
      companyLogo:     '',
      companyWebsite:  raw.url || '',
      source:          'workable',
      externalId:      raw.shortcode,
      externalUrl:     raw.url,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = WorkableAdapter;

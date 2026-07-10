// services/ingestion/adapters/greenhouseAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

const GREENHOUSE_COMPANIES = [
  { token: 'constellationsoftware', name: 'Contour Software' },
  { token: 'motive', name: 'Motive' },
  { token: 'mercycorps', name: 'Mercy Corps' },
  { token: 'spacex', name: 'SpaceX' },
  { token: 'teachforindia', name: 'Teach for India' }
];

class GreenhouseAdapter extends BaseAdapter {
  constructor() {
    super('greenhouse');
  }

  async fetchJobs() {
    console.log('🔌 [Ingestion] Greenhouse adapter fetching jobs...');
    const allNormalizedJobs = [];

    for (const company of GREENHOUSE_COMPANIES) {
      try {
        console.log(`   └─ Fetching jobs for ${company.name} (${company.token})`);
        const url = `https://boards-api.greenhouse.io/v1/boards/${company.token}/jobs?content=true`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data || !Array.isArray(response.data.jobs)) {
          console.warn(`⚠️  [Ingestion] Invalid response from Greenhouse for company ${company.name}`);
          continue;
        }

        let normalized = response.data.jobs.map(job => this.normalize(job, company.name));
        if (normalized.length > 40) {
          console.log(`   └─ Ingesting top 40 of ${normalized.length} jobs for ${company.name} to maintain category balance.`);
          normalized = normalized.slice(0, 40);
        }
        allNormalizedJobs.push(...normalized);
      } catch (err) {
        console.error(`❌ [Ingestion] Greenhouse failed for company ${company.name}:`, err.message);
      }
    }

    return allNormalizedJobs;
  }

  normalize(raw, companyName) {
    const cleanDescription = this.stripHtml(raw.content || '');
    const extractedSkills = this.extractSkillsFromText(cleanDescription);

    const rawLocation = raw.location?.name || 'Pakistan';
    const isRemote = rawLocation.toLowerCase().includes('remote') || rawLocation.toLowerCase().includes('anywhere');

    return {
      title:           raw.title || 'Software Engineer',
      department:      'Engineering',
      category:        'Technology',
      location:        rawLocation,
      locationType:    isRemote ? 'Remote' : 'On-site',
      type:            'Full-time', // Greenhouse doesn't return commitment uniformly in boards API, default to Full-time
      salary:          'Competitive',
      salaryMin:       0,
      salaryMax:       0,
      currency:        'PKR',
      email:           'recruiting@deftcrew.com',
      description:     cleanDescription,
      requirements:    [],
      responsibilities: [],
      benefits:        [],
      experienceLevel: raw.title?.toLowerCase().includes('senior') || raw.title?.toLowerCase().includes('lead') ? 'Senior Level' : 'Mid Level',
      skills:          extractedSkills.slice(0, 10),
      active:          true,
      companyName:     companyName,
      companyLogo:     '',
      companyWebsite:  `https://boards.greenhouse.io/${companyName.toLowerCase().replace(/\s+/g, '')}`,
      source:          'greenhouse',
      externalId:      raw.id.toString(),
      externalUrl:     raw.absolute_url,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = GreenhouseAdapter;

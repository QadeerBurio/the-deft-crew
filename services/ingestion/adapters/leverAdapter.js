// services/ingestion/adapters/leverAdapter.js
const axios = require('axios');
const BaseAdapter = require('../BaseAdapter');

const LEVER_COMPANIES = [
  { id: 'educative', name: 'Educative' },
  { id: 'teachforamerica', name: 'Teach for America' },
  { id: 'redcross', name: 'Red Cross' },
  { id: 'netflix', name: 'Netflix' }
];

class LeverAdapter extends BaseAdapter {
  constructor() {
    super('lever');
  }

  async fetchJobs() {
    console.log('🔌 [Ingestion] Lever adapter fetching jobs...');
    const allNormalizedJobs = [];

    for (const company of LEVER_COMPANIES) {
      try {
        console.log(`   └─ Fetching jobs for ${company.name} (${company.id})`);
        const url = `https://api.lever.co/v0/postings/${company.id}`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!Array.isArray(response.data)) {
          console.warn(`⚠️  [Ingestion] Invalid response from Lever for company ${company.name}`);
          continue;
        }

        let normalized = response.data.map(job => this.normalize(job, company.name));
        if (normalized.length > 40) {
          console.log(`   └─ Ingesting top 40 of ${normalized.length} jobs for ${company.name} to maintain category balance.`);
          normalized = normalized.slice(0, 40);
        }
        allNormalizedJobs.push(...normalized);
      } catch (err) {
        console.error(`❌ [Ingestion] Lever failed for company ${company.name}:`, err.message);
      }
    }

    return allNormalizedJobs;
  }

  normalize(raw, companyName) {
    // Lever descriptions are formatted in HTML sections (description, lists, additional)
    const rawDescription = [
      raw.descriptionHtml || '',
      ...(Array.isArray(raw.lists) ? raw.lists.map(l => `<h3>${l.text}</h3>${l.content || ''}`) : []),
      raw.additionalPlain || ''
    ].join('\n');

    const cleanDescription = this.stripHtml(rawDescription);
    const extractedSkills = this.extractSkillsFromText(cleanDescription);

    const rawLocation = raw.categories?.location || 'Pakistan';
    const isRemote = rawLocation.toLowerCase().includes('remote') || rawLocation.toLowerCase().includes('anywhere');

    return {
      title:           raw.categories?.commitment === 'Internship' ? `${raw.title || 'Software Opportunity'} (Internship)` : (raw.title || 'Software Engineer'),
      department:      raw.categories?.team || 'Technology',
      category:        this.mapCategory(raw.categories?.team || 'Technology'),
      location:        rawLocation,
      locationType:    isRemote ? 'Remote' : 'On-site',
      type:            this.mapEmploymentType(raw.categories?.commitment),
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
      companyWebsite:  `https://lever.co/postings/${companyName.toLowerCase()}`,
      source:          'lever',
      externalId:      raw.id,
      externalUrl:     raw.hostedUrl,
      isExternal:      true,
      lastFetchedAt:   new Date()
    };
  }
}

module.exports = LeverAdapter;

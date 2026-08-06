const OpenAI = require('openai');

class Normalizer {
  constructor() {
    this.openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
    this.fallbackBanners = [
      "https://images.unsplash.com/photo-1523240715632-d984bb4b970e?w=800",
      "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=800",
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800",
      "https://images.unsplash.com/photo-1511578314322-379afb476865?w=800",
      "https://images.unsplash.com/photo-1531482615713-2afd69097998?w=800"
    ];
  }

  /**
   * Main normalize function for raw event object
   */
  async normalize(rawEvent) {
    let normalized = this.ruleBasedNormalization(rawEvent);

    // Optional AI enhancement if explicitly requested/configured
    if (this.openai && process.env.ENABLE_AI_EVENT_NORMALIZATION === 'true' && rawEvent.description && rawEvent.description.length > 50) {
      try {
        const aiData = await this.aiNormalization(rawEvent);
        normalized = { ...normalized, ...aiData };
      } catch (err) {
        console.warn(`⚠️ [Normalizer] AI normalization skipped for "${rawEvent.title}": ${err.message}`);
      }
    }

    return normalized;
  }

  /**
   * Deterministic Rule-Based Normalization
   */
  ruleBasedNormalization(raw) {
    const title = (raw.title || 'Untitled Event').trim();
    const organizer = (raw.organizer || 'Karachi Event Host').trim();
    const city = 'Karachi';
    const country = 'Pakistan';

    const category = this.detectCategory(title, raw.description, raw.rawType);
    const tags = this.extractTags(title, raw.description, category);
    const searchKeywords = this.generateKeywords(title, organizer, category, raw.venue);

    const image = raw.image && raw.image.startsWith('http') 
      ? raw.image 
      : this.getRandomFallbackImage(category);

    const startDate = raw.start ? new Date(raw.start) : new Date();
    const dateFormatted = isNaN(startDate.getTime()) 
      ? 'TBA' 
      : startDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    const deadlineFormatted = raw.end ? new Date(raw.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Limited Spots';

    return {
      title,
      organizer,
      city,
      country,
      type: category,
      categories: [category],
      description: (raw.description || '').trim(),
      prize: raw.prize || 'TBD / Certificates',
      deadline: deadlineFormatted,
      location: raw.venue || raw.address || 'Karachi Venue',
      latitude: raw.latitude || null,
      longitude: raw.longitude || null,
      contact: raw.contact || raw.organizerWebsite || 'info@tdc.app',
      image,
      imageSource: raw.image ? raw.source : 'unsplash',
      date: dateFormatted,
      teamSize: raw.teamSize || '1-4 Members',
      source: raw.source || 'manual',
      sourceId: raw.sourceId ? String(raw.sourceId) : null,
      externalUrl: raw.externalUrl || '',
      registrationUrl: raw.registrationUrl || raw.externalUrl || '',
      organizerWebsite: raw.organizerWebsite || '',
      status: 'approved',
      verified: raw.source === 'eventbrite' || raw.source === 'meetup',
      featured: false,
      pinned: false,
      lastSynced: new Date(),
      syncProvider: raw.source || 'manual',
      isImported: raw.source !== 'manual',
      isExpired: false,
      tags,
      searchKeywords
    };
  }

  /**
   * Category Detector based on title & text keywords
   */
  detectCategory(title, description = '', rawType = '') {
    const text = `${title} ${description} ${rawType}`.toLowerCase();

    if (/hackathon|buildathon|codefest|coding|devfest|ai challenge/i.test(text)) return 'Hackathons';
    if (/workshop|training|bootcamp|hands-on|masterclass|course/i.test(text)) return 'Workshops';
    if (/conference|summit|symposium|keynote|forum/i.test(text)) return 'Conferences';
    if (/competition|tournament|challenge|contest|olympiad/i.test(text)) return 'Competitions';
    if (/career|job fair|expo|recruiting|hiring|founder|mixer/i.test(text)) return 'Career Fairs';
    if (/concert|music|gig|band|musical|qawwali/i.test(text)) return 'Concerts';
    if (/poetry|mushaira|literary|klf|literature|poetry night/i.test(text)) return 'Poetry';

    return 'Workshops';
  }

  extractTags(title, description = '', category = '') {
    const text = `${title} ${description}`.toLowerCase();
    const tagList = new Set([category]);

    if (/ai|artificial intelligence|generative ai|llm|gpt/i.test(text)) tagList.add('AI & ML');
    if (/cloud|azure|aws|devops|docker|kubernetes/i.test(text)) tagList.add('Cloud & DevOps');
    if (/react|mobile|flutter|react native|expo|app/i.test(text)) tagList.add('Mobile App');
    if (/startup|founder|vc|pitch|incubation/i.test(text)) tagList.add('Startup');
    if (/student|university|iba|fast|ned|habib/i.test(text)) tagList.add('University');
    if (/free/i.test(text)) tagList.add('Free Event');

    return Array.from(tagList);
  }

  generateKeywords(title, organizer, category, venue = '') {
    const words = `${title} ${organizer} ${category} ${venue} Karachi Pakistan`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

    return Array.from(new Set(words));
  }

  getRandomFallbackImage(category) {
    const categoryImages = {
      Hackathons: "https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=800",
      Workshops: "https://images.unsplash.com/photo-1531482615713-2afd69097998?w=800",
      Conferences: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800",
      Competitions: "https://images.unsplash.com/photo-1511578314322-379afb476865?w=800",
      "Career Fairs": "https://images.unsplash.com/photo-1556761175-5973dc0f32e7?w=800",
      Concerts: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800",
      Poetry: "https://images.unsplash.com/photo-1455390582262-044cdead277a?w=800"
    };

    return categoryImages[category] || this.fallbackBanners[Math.floor(Math.random() * this.fallbackBanners.length)];
  }

  /**
   * OpenAI API Normalization Call
   */
  async aiNormalization(raw) {
    const prompt = `Extract clean event metadata in JSON format for this Karachi event:
Title: ${raw.title}
Description: ${raw.description.slice(0, 500)}

Return JSON with keys:
- cleanTitle: refined clear title
- category: one of ["Hackathons", "Workshops", "Conferences", "Competitions", "Career Fairs", "Concerts", "Poetry"]
- tags: array of 3-5 relevant short tags
- searchKeywords: array of 5-8 search terms`;

    const response = await this.openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 300
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');

    return {
      title: parsed.cleanTitle || raw.title,
      type: parsed.category || 'Workshops',
      categories: [parsed.category || 'Workshops'],
      tags: parsed.tags || [],
      searchKeywords: parsed.searchKeywords || []
    };
  }
}

module.exports = new Normalizer();

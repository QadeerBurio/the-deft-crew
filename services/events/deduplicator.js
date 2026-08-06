const { Event } = require('../../models/Event');

class Deduplicator {
  /**
   * Check if incoming normalized event is a duplicate of an existing event in DB
   * @param {Object} normalizedEvent 
   * @returns {Promise<{ isDuplicate: boolean, existingEvent: Object|null, reason: string|null }>}
   */
  async checkDuplicate(normalizedEvent) {
    // 1. Direct Source + Source ID Check
    if (normalizedEvent.source && normalizedEvent.sourceId) {
      const existingById = await Event.findOne({
        source: normalizedEvent.source,
        sourceId: normalizedEvent.sourceId
      });
      if (existingById) {
        return { isDuplicate: true, existingEvent: existingById, reason: 'Exact Source & SourceId Match' };
      }
    }

    // 2. Exact Title + Organizer Check
    const exactMatch = await Event.findOne({
      title: { $regex: new RegExp(`^${this.escapeRegex(normalizedEvent.title)}$`, 'i') },
      organizer: { $regex: new RegExp(`^${this.escapeRegex(normalizedEvent.organizer)}$`, 'i') },
      isExpired: false
    });

    if (exactMatch) {
      return { isDuplicate: true, existingEvent: exactMatch, reason: 'Exact Title & Organizer Match' };
    }

    // 3. Fuzzy Title Match within Active Events
    const candidateEvents = await Event.find({
      isExpired: false,
      status: { $ne: 'rejected' }
    }).limit(200);

    for (const candidate of candidateEvents) {
      const titleSim = this.calculateSimilarity(normalizedEvent.title, candidate.title);
      const isSameDate = normalizedEvent.date === candidate.date || normalizedEvent.deadline === candidate.deadline;

      if (titleSim > 0.85 && isSameDate) {
        return { isDuplicate: true, existingEvent: candidate, reason: `Fuzzy Title Similarity (${(titleSim * 100).toFixed(0)}%) & Date Match` };
      }
    }

    return { isDuplicate: false, existingEvent: null, reason: null };
  }

  /**
   * String similarity algorithm (Token Jaccard + Levenshtein hybrid)
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const s2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

    if (s1 === s2) return 1.0;

    const set1 = new Set(s1.split(/\s+/));
    const set2 = new Set(s2.split(/\s+/));

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = new Deduplicator();

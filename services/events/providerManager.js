const EventbriteProvider = require('./providers/eventbriteProvider');
const MeetupProvider = require('./providers/meetupProvider');
const RssProvider = require('./providers/rssProvider');
const ScraperProvider = require('./providers/scraperProvider');

class ProviderManager {
  constructor() {
    this.providers = new Map();
    this.providerStats = new Map();
    this.registerDefaultProviders();
  }

  registerDefaultProviders() {
    this.registerProvider(new EventbriteProvider());
    this.registerProvider(new MeetupProvider());
    this.registerProvider(new RssProvider());
    this.registerProvider(new ScraperProvider());
  }

  registerProvider(providerInstance) {
    if (!providerInstance.name) {
      throw new Error("Provider must have a valid name property.");
    }
    this.providers.set(providerInstance.name, providerInstance);
    this.providerStats.set(providerInstance.name, {
      name: providerInstance.name,
      enabled: providerInstance.enabled,
      lastSync: null,
      status: 'idle',
      totalFetched: 0,
      lastError: null
    });
    console.log(`🔌 [ProviderManager] Registered provider: ${providerInstance.name}`);
  }

  getProvider(name) {
    return this.providers.get(name);
  }

  getProviderStatuses() {
    return Array.from(this.providerStats.values());
  }

  async fetchAllEvents(targetProviderName = null) {
    const rawEvents = [];
    const providersToRun = targetProviderName 
      ? [this.providers.get(targetProviderName)].filter(Boolean)
      : Array.from(this.providers.values());

    for (const provider of providersToRun) {
      if (!provider.enabled) continue;

      const stats = this.providerStats.get(provider.name);
      stats.status = 'syncing';
      stats.lastSync = new Date();

      try {
        console.log(`🚀 [ProviderManager] Running provider sync: ${provider.name}...`);
        const events = await provider.fetchEvents();
        stats.status = 'success';
        stats.totalFetched += events.length;
        stats.lastError = null;
        rawEvents.push(...events);
      } catch (err) {
        console.error(`❌ [ProviderManager] Provider ${provider.name} failed: ${err.message}`);
        stats.status = 'error';
        stats.lastError = err.message;
      }
    }

    return rawEvents;
  }
}

module.exports = new ProviderManager();

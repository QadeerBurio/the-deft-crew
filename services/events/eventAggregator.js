const providerManager = require('./providerManager');
const normalizer = require('./normalizer');
const deduplicator = require('./deduplicator');
const eventCleanup = require('./eventCleanup');
const eventValidator = require('./validators');
const { Event } = require('../../models/Event');
const eventSocket = require('../../socket/eventSocket');

class EventAggregator {
  constructor() {
    this.isSyncing = false;
    this.lastSyncResult = null;
  }

  /**
   * Primary ingestion pipeline execution
   */
  async runAggregation(targetProvider = null) {
    if (this.isSyncing) {
      // console.log('⚠️ [EventAggregator] Ingestion pipeline is already running. Skipping concurrent run.');
      return { status: 'busy', message: 'Sync already in progress' };
    }

    this.isSyncing = true;
    const startTime = Date.now();
    // console.log(`🌐 [EventAggregator] Starting automated Karachi event aggregation pipeline...`);

    const summary = {
      startTime: new Date(),
      totalFetched: 0,
      insertedCount: 0,
      updatedCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      expiredCount: 0,
      purgedCount: 0,
      importedEvents: [],
      errors: []
    };

    try {
      const providersToRun = targetProvider
        ? [providerManager.getProvider(targetProvider)].filter(Boolean)
        : Array.from(providerManager.providers.values());

      for (const provider of providersToRun) {
        if (!provider.enabled) continue;

        const providerMetrics = {
          name: provider.name,
          fetched: 0,
          normalized: 0,
          inserted: 0,
          updated: 0,
          duplicates: 0
        };

        try {
          const rawList = await provider.fetchEvents();
          providerMetrics.fetched = rawList.length;
          summary.totalFetched += rawList.length;

          for (const raw of rawList) {
            try {
              const normalized = await normalizer.normalize(raw);
              providerMetrics.normalized++;

              const validation = eventValidator.validate(normalized);
              if (!validation.isValid) {
                summary.invalidCount++;
                continue;
              }

              const dupCheck = await deduplicator.checkDuplicate(normalized);

              if (dupCheck.isDuplicate) {
                summary.duplicateCount++;
                providerMetrics.duplicates++;
                if (dupCheck.existingEvent) {
                  dupCheck.existingEvent.lastSynced = new Date();
                  if (normalized.externalUrl) dupCheck.existingEvent.externalUrl = normalized.externalUrl;
                  await dupCheck.existingEvent.save();
                  summary.updatedCount++;
                  providerMetrics.updated++;
                }
              } else {
                const newEventDoc = new Event(normalized);
                const savedEvent = await newEventDoc.save();
                summary.insertedCount++;
                providerMetrics.inserted++;
                summary.importedEvents.push(savedEvent);
              }
            } catch (err) {
              console.error(`❌ [EventAggregator] Error processing raw event "${raw.title}":`, err.message);
              summary.errors.push({ title: raw.title, error: err.message });
            }
          }

          // console.log(`📊 Provider: ${providerMetrics.name}\n   Fetched: ${providerMetrics.fetched}\n   Normalized: ${providerMetrics.normalized}\n   Inserted: ${providerMetrics.inserted}\n   Updated: ${providerMetrics.updated}\n   Duplicates: ${providerMetrics.duplicates}`);

        } catch (pErr) {
          console.error(`❌ [EventAggregator] Provider ${provider.name} failed: ${pErr.message}`);
        }
      }

      // 3. Expiration & Cleanup scan
      summary.expiredCount = await eventCleanup.expirePastEvents();
      summary.purgedCount = await eventCleanup.purgeExpiredEvents();

      // 4. Emit Socket.io notifications to connected clients
      if (summary.insertedCount > 0) {
        eventSocket.emitNewEventsImported(summary.insertedCount, summary.importedEvents);
      }
      if (summary.expiredCount > 0) {
        eventSocket.emitEventsExpired(summary.expiredCount);
      }

      const durationMs = Date.now() - startTime;
      // console.log(`✅ [EventAggregator] Pipeline completed in ${durationMs}ms. Inserted: ${summary.insertedCount}, Updated: ${summary.updatedCount}, Duplicates: ${summary.duplicateCount}, Expired: ${summary.expiredCount}`);

      this.lastSyncResult = {
        success: true,
        durationMs,
        summary
      };

      return this.lastSyncResult;
    } catch (err) {
      console.error('❌ [EventAggregator] Pipeline execution failed:', err);
      this.lastSyncResult = { success: false, error: err.message };
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  getAggregationStats() {
    return {
      isSyncing: this.isSyncing,
      lastSyncResult: this.lastSyncResult,
      providers: providerManager.getProviderStatuses()
    };
  }
}

module.exports = new EventAggregator();

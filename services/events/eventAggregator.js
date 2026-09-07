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
      return { status: 'busy', message: 'Sync already in progress' };
    }

    this.isSyncing = true;
    const startTime = Date.now();

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
      // Expiration & Cleanup scan
      summary.expiredCount = await eventCleanup.expirePastEvents();
      summary.purgedCount = await eventCleanup.purgeExpiredEvents();

      // Emit Socket.io notifications to connected clients
      if (summary.insertedCount > 0) {
        eventSocket.emitNewEventsImported(summary.insertedCount, summary.importedEvents);
      }
      if (summary.expiredCount > 0) {
        eventSocket.emitEventsExpired(summary.expiredCount);
      }

      const durationMs = Date.now() - startTime;

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
      providers: []
    };
  }
}

module.exports = new EventAggregator();

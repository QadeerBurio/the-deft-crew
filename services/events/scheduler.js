const cron = require('node-cron');
const eventAggregator = require('./eventAggregator');
const eventCleanup = require('./eventCleanup');

class EventScheduler {
  constructor() {
    this.cronSchedule = process.env.EVENT_SYNC_INTERVAL_CRON || '0 * * * *'; // Default: Hourly
    this.task = null;
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;
    this.initialized = true;

    console.log(`⏱️ [EventScheduler] Initializing automated event cron scheduler (${this.cronSchedule})...`);

    if (cron.validate(this.cronSchedule)) {
      this.task = cron.schedule(this.cronSchedule, async () => {
        console.log(`⏰ [EventScheduler] Triggering scheduled event sync pass...`);
        try {
          await eventAggregator.runAggregation();
        } catch (err) {
          console.error(`❌ [EventScheduler] Scheduled sync error:`, err);
        }
      });
    } else {
      console.warn(`⚠️ [EventScheduler] Invalid cron expression '${this.cronSchedule}'. Falling back to 1-hour interval timer.`);
      setInterval(async () => {
        try {
          await eventAggregator.runAggregation();
        } catch (err) {
          console.error(`❌ [EventScheduler] Interval sync error:`, err);
        }
      }, 60 * 60 * 1000);
    }

    // Trigger initial startup aggregation pass after 10 seconds delay to populate feed
    setTimeout(() => {
      console.log('🚀 [EventScheduler] Running initial startup Karachi event aggregation pass...');
      eventAggregator.runAggregation().catch(err => {
        console.error('❌ [EventScheduler] Initial startup aggregation failed:', err);
      });
    }, 10000);
  }
}

module.exports = new EventScheduler();

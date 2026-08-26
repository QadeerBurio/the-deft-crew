const { Event } = require('../../models/Event');

class EventCleanup {
  constructor() {
    this.retentionDays = parseInt(process.env.EVENT_EXPIRED_RETENTION_DAYS || '7', 10);
  }

  /**
   * Run expiration scan to flag past events as expired
   */
  async expirePastEvents() {
    // console.log('⏰ [EventCleanup] Running event expiration pass...');
    const now = new Date();
    let expiredCount = 0;

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const activeEvents = await Event.find({ isExpired: false });

    for (const event of activeEvents) {
      let isPast = false;

      // Only expire if event.date is a valid date strictly before start of today
      if (event.date && event.date !== 'TBA') {
        const eventDate = new Date(event.date);
        if (!isNaN(eventDate.getTime()) && eventDate < startOfToday) {
          isPast = true;
        }
      }

      if (isPast) {
        event.isExpired = true;
        event.status = 'expired';
        event.expiredAt = now;
        await event.save();
        expiredCount++;
      }
    }

    // console.log(`✅ [EventCleanup] Flagged ${expiredCount} past events as expired.`);
    return expiredCount;
  }

  /**
   * Permanently purge expired events older than retention duration
   */
  async purgeExpiredEvents() {
    // console.log(`🧹 [EventCleanup] Purging expired events older than ${this.retentionDays} days...`);
    const cutoffDate = new Date(Date.now() - this.retentionDays * 86400000);

    const result = await Event.deleteMany({
      isExpired: true,
      $or: [
        { expiredAt: { $lt: cutoffDate } },
        { createdAt: { $lt: cutoffDate } }
      ]
    });

    // console.log(`✅ [EventCleanup] Permanently deleted ${result.deletedCount} old expired events.`);
    return result.deletedCount;
  }
}

module.exports = new EventCleanup();

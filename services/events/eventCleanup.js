const { Event } = require('../../models/Event');

class EventCleanup {
  constructor() {
    this.retentionDays = parseInt(process.env.EVENT_EXPIRED_RETENTION_DAYS || '7', 10);
  }

  /**
   * Run expiration scan to flag past events as expired based on parsedDate
   */
  async expirePastEvents() {
    const now = new Date();
    let expiredCount = 0;

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const activeEvents = await Event.find({ isExpired: false });

    for (const event of activeEvents) {
      let isPast = false;

      // Only expire if event.parsedDate is a valid date strictly before start of today
      if (event.parsedDate && event.parsedDate instanceof Date && !isNaN(event.parsedDate.getTime())) {
        if (event.parsedDate < startOfToday) {
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

    return expiredCount;
  }

  /**
   * Permanently purge expired events older than retention duration
   */
  async purgeExpiredEvents() {
    const cutoffDate = new Date(Date.now() - this.retentionDays * 86400000);

    const result = await Event.deleteMany({
      isExpired: true,
      $or: [
        { expiredAt: { $lt: cutoffDate } },
        { createdAt: { $lt: cutoffDate } }
      ]
    });

    return result.deletedCount;
  }
}

module.exports = new EventCleanup();

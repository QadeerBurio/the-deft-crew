"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schedulerService = exports.SchedulerService = void 0;
const envValidator_1 = require("../config/envValidator");
const logger_1 = require("../config/logger");
const syncEngine_service_1 = require("./syncEngine.service");
class SchedulerService {
    syncInterval = null;
    /**
     * Initializes the scheduler on server startup.
     */
    async initialize() {
        logger_1.logger.info('Initializing Automatic Knowledge Synchronization Scheduler...');
        // 1. Run startup incremental sync in the background
        // (runs shortly after database boots)
        setTimeout(async () => {
            try {
                logger_1.logger.info('Executing initial startup database synchronization check...');
                await syncEngine_service_1.syncEngineService.triggerSync('incremental');
            }
            catch (err) {
                logger_1.logger.error('Startup database synchronization check failed:', err.message);
            }
        }, 5000); // 5-second buffer to allow connection stabilization
        // 2. Set up interval loop for periodic sync runs
        const intervalMs = envValidator_1.env.SYNC_INTERVAL_MINUTES * 60 * 1000;
        logger_1.logger.info(`Scheduling database sync sweeps every ${envValidator_1.env.SYNC_INTERVAL_MINUTES} minutes (${intervalMs}ms).`);
        this.syncInterval = setInterval(async () => {
            try {
                logger_1.logger.info('Timer triggered. Checking for automatic database sync run...');
                // Retrieve current status
                const status = await syncEngine_service_1.syncEngineService.getSyncStatus();
                if (status.isSyncing) {
                    logger_1.logger.warn('Sync job skipped. Another synchronization session is already in progress.');
                    return;
                }
                await syncEngine_service_1.syncEngineService.triggerSync('incremental');
            }
            catch (err) {
                logger_1.logger.error('Periodic database synchronization run encountered an error:', err);
            }
        }, intervalMs);
    }
    /**
     * Stops the active interval timer.
     */
    shutdown() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            logger_1.logger.info('Synchronization scheduler stopped.');
        }
    }
}
exports.SchedulerService = SchedulerService;
exports.schedulerService = new SchedulerService();
exports.default = exports.schedulerService;
//# sourceMappingURL=scheduler.service.js.map
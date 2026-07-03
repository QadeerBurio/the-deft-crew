import { env } from '../config/envValidator';
import { logger } from '../config/logger';
import { syncEngineService } from './syncEngine.service';

export class SchedulerService {
  private syncInterval: NodeJS.Timeout | null = null;

  /**
   * Initializes the scheduler on server startup.
   */
  public async initialize(): Promise<void> {
    logger.info('Initializing Automatic Knowledge Synchronization Scheduler...');
    
    // 1. Run startup incremental sync in the background
    // (runs shortly after database boots)
    setTimeout(async () => {
      try {
        logger.info('Executing initial startup database synchronization check...');
        await syncEngineService.triggerSync('incremental');
      } catch (err: any) {
        logger.error('Startup database synchronization check failed:', err.message);
      }
    }, 5000); // 5-second buffer to allow connection stabilization

    // 2. Set up interval loop for periodic sync runs
    const intervalMs = env.SYNC_INTERVAL_MINUTES * 60 * 1000;
    logger.info(`Scheduling database sync sweeps every ${env.SYNC_INTERVAL_MINUTES} minutes (${intervalMs}ms).`);
    
    this.syncInterval = setInterval(async () => {
      try {
        logger.info('Timer triggered. Checking for automatic database sync run...');
        
        // Retrieve current status
        const status = await syncEngineService.getSyncStatus();
        if (status.isSyncing) {
          logger.warn('Sync job skipped. Another synchronization session is already in progress.');
          return;
        }

        await syncEngineService.triggerSync('incremental');
      } catch (err: any) {
        logger.error('Periodic database synchronization run encountered an error:', err);
      }
    }, intervalMs);
  }

  /**
   * Stops the active interval timer.
   */
  public shutdown(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      logger.info('Synchronization scheduler stopped.');
    }
  }
}

export const schedulerService = new SchedulerService();
export default schedulerService;

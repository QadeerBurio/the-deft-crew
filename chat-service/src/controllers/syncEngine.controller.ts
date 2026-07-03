import { Request, Response, NextFunction } from 'express';
import { syncEngineService } from '../services/syncEngine.service';

export class SyncEngineController {
  /**
   * Triggers a Full Sync job in the background.
   */
  public async triggerFullSync(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const syncMeta = await syncEngineService.triggerSync('full');
      res.status(202).json({
        success: true,
        message: 'Full database synchronization job initiated in the background.',
        jobId: syncMeta._id,
        status: syncMeta.status,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Triggers an Incremental Sync job in the background.
   */
  public async triggerIncrementalSync(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const syncMeta = await syncEngineService.triggerSync('incremental');
      res.status(202).json({
        success: true,
        message: 'Incremental database synchronization job initiated in the background.',
        jobId: syncMeta._id,
        status: syncMeta.status,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Triggers synchronization for a specific source adapter name (e.g. jobs, scholarships).
   */
  public async triggerSourceSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sourceName = req.params.name;
      const result = await syncEngineService.triggerSourceSync(sourceName);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Returns current and last run status of the sync engine.
   */
  public async getSyncStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await syncEngineService.getSyncStatus();
      res.status(200).json({
        success: true,
        data: status,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Returns cumulative synchronization run metrics.
   */
  public async getSyncStatistics(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await syncEngineService.getSyncStatistics();
      res.status(200).json({
        success: true,
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const syncEngineController = new SyncEngineController();
export default syncEngineController;

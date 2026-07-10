import { Router } from 'express';
import { syncEngineController } from '../controllers/syncEngine.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminMiddleware } from '../middleware/admin.middleware';

const router = Router();

// Protect all sync operations with authentication and admin privileges
router.use(authMiddleware, adminMiddleware);

// Sync operations
router.post('/full', syncEngineController.triggerFullSync.bind(syncEngineController));
router.post('/incremental', syncEngineController.triggerIncrementalSync.bind(syncEngineController));
router.post('/source/:name', syncEngineController.triggerSourceSync.bind(syncEngineController));

// Status and statistics metrics
router.get('/status', syncEngineController.getSyncStatus.bind(syncEngineController));
router.get('/statistics', syncEngineController.getSyncStatistics.bind(syncEngineController));

export default router;

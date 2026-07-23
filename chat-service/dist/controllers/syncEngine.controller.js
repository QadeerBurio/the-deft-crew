"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncEngineController = exports.SyncEngineController = void 0;
const syncEngine_service_1 = require("../services/syncEngine.service");
class SyncEngineController {
    /**
     * Triggers a Full Sync job in the background.
     */
    async triggerFullSync(_req, res, next) {
        try {
            const syncMeta = await syncEngine_service_1.syncEngineService.triggerSync('full');
            res.status(202).json({
                success: true,
                message: 'Full database synchronization job initiated in the background.',
                jobId: syncMeta._id,
                status: syncMeta.status,
            });
        }
        catch (err) {
            next(err);
        }
    }
    /**
     * Triggers an Incremental Sync job in the background.
     */
    async triggerIncrementalSync(_req, res, next) {
        try {
            const syncMeta = await syncEngine_service_1.syncEngineService.triggerSync('incremental');
            res.status(202).json({
                success: true,
                message: 'Incremental database synchronization job initiated in the background.',
                jobId: syncMeta._id,
                status: syncMeta.status,
            });
        }
        catch (err) {
            next(err);
        }
    }
    /**
     * Triggers synchronization for a specific source adapter name (e.g. jobs, scholarships).
     */
    async triggerSourceSync(req, res, next) {
        try {
            const sourceName = req.params.name;
            const result = await syncEngine_service_1.syncEngineService.triggerSourceSync(sourceName);
            res.status(200).json(result);
        }
        catch (err) {
            next(err);
        }
    }
    /**
     * Returns current and last run status of the sync engine.
     */
    async getSyncStatus(_req, res, next) {
        try {
            const status = await syncEngine_service_1.syncEngineService.getSyncStatus();
            res.status(200).json({
                success: true,
                data: status,
            });
        }
        catch (err) {
            next(err);
        }
    }
    /**
     * Returns cumulative synchronization run metrics.
     */
    async getSyncStatistics(_req, res, next) {
        try {
            const stats = await syncEngine_service_1.syncEngineService.getSyncStatistics();
            res.status(200).json({
                success: true,
                data: stats,
            });
        }
        catch (err) {
            next(err);
        }
    }
}
exports.SyncEngineController = SyncEngineController;
exports.syncEngineController = new SyncEngineController();
exports.default = exports.syncEngineController;
//# sourceMappingURL=syncEngine.controller.js.map
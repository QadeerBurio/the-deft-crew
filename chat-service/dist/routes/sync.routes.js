"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const syncEngine_controller_1 = require("../controllers/syncEngine.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const admin_middleware_1 = require("../middleware/admin.middleware");
const router = (0, express_1.Router)();
// Protect all sync operations with authentication and admin privileges
router.use(auth_middleware_1.authMiddleware, admin_middleware_1.adminMiddleware);
// Sync operations
router.post('/full', syncEngine_controller_1.syncEngineController.triggerFullSync.bind(syncEngine_controller_1.syncEngineController));
router.post('/incremental', syncEngine_controller_1.syncEngineController.triggerIncrementalSync.bind(syncEngine_controller_1.syncEngineController));
router.post('/source/:name', syncEngine_controller_1.syncEngineController.triggerSourceSync.bind(syncEngine_controller_1.syncEngineController));
// Status and statistics metrics
router.get('/status', syncEngine_controller_1.syncEngineController.getSyncStatus.bind(syncEngine_controller_1.syncEngineController));
router.get('/statistics', syncEngine_controller_1.syncEngineController.getSyncStatistics.bind(syncEngine_controller_1.syncEngineController));
exports.default = router;
//# sourceMappingURL=sync.routes.js.map
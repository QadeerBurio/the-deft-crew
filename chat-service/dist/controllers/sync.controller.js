"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncSourceData = void 0;
const sync_service_1 = require("../services/sync.service");
const asyncHandler_1 = require("../utils/asyncHandler");
exports.syncSourceData = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { source } = req.params;
    const result = await sync_service_1.syncService.syncSource(source, req.body);
    res.status(200).json({
        success: true,
        message: `Data synchronized successfully for source: ${source}`,
        data: result,
    });
});
exports.default = exports.syncSourceData;
//# sourceMappingURL=sync.controller.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHealth = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
exports.getHealth = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    res.status(200).json({
        success: true,
        service: 'tdc-chat-service',
        status: 'healthy',
        version: '1.0.0',
    });
});
exports.default = exports.getHealth;
//# sourceMappingURL=health.controller.js.map
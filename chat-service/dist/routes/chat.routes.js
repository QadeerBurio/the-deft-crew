"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const controller = __importStar(require("../controllers/chat.controller"));
const validate_middleware_1 = require("../middleware/validate.middleware");
const chat_validator_1 = require("../validators/chat.validator");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
router.post('/message', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(chat_validator_1.chatMessageSchema), controller.postMessage);
router.post('/stream', auth_middleware_1.authMiddleware, (0, validate_middleware_1.validate)(chat_validator_1.chatMessageSchema), controller.postStream);
router.get('/sessions', auth_middleware_1.authMiddleware, controller.getSessions);
router.get('/history/:sessionId', auth_middleware_1.authMiddleware, controller.getHistory);
router.delete('/session/:sessionId', auth_middleware_1.authMiddleware, controller.deleteSession);
router.post('/title', auth_middleware_1.authMiddleware, controller.updateTitle);
router.get('/suggestions', auth_middleware_1.authMiddleware, controller.getSuggestions);
router.get('/status', auth_middleware_1.authMiddleware, controller.getStatus);
exports.default = router;
//# sourceMappingURL=chat.routes.js.map
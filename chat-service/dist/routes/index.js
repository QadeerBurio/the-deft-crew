"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const health_routes_1 = __importDefault(require("./health.routes"));
const chat_routes_1 = __importDefault(require("./chat.routes"));
const knowledge_routes_1 = __importDefault(require("./knowledge.routes"));
const sync_routes_1 = __importDefault(require("./sync.routes"));
const travel_routes_1 = __importDefault(require("./travel.routes"));
const router = (0, express_1.Router)();
// Mount individual domain sub-routers
router.use('/health', health_routes_1.default);
router.use('/chat', chat_routes_1.default);
router.use('/knowledge', knowledge_routes_1.default);
router.use('/sync', sync_routes_1.default);
router.use('/travel', travel_routes_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map
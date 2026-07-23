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
const controller = __importStar(require("../controllers/knowledge.controller"));
const validate_middleware_1 = require("../middleware/validate.middleware");
const knowledge_validator_1 = require("../validators/knowledge.validator");
const auth_middleware_1 = require("../middleware/auth.middleware");
const admin_middleware_1 = require("../middleware/admin.middleware");
const router = (0, express_1.Router)();
// Protect all knowledge base endpoints with authentication
router.use(auth_middleware_1.authMiddleware);
// Vector search and statistics routes (register these before GET /:id to prevent parameter conflict)
router.get('/statistics', admin_middleware_1.adminMiddleware, controller.getStatistics);
router.post('/search', controller.searchKnowledge);
router.post('/reindex', admin_middleware_1.adminMiddleware, controller.reindexAll);
router.post('/reindex/:id', admin_middleware_1.adminMiddleware, controller.reindexDocument);
// General REST routes
router.get('/', controller.listDocuments);
router.get('/:id', controller.getDocument);
router.post('/', admin_middleware_1.adminMiddleware, (0, validate_middleware_1.validate)(knowledge_validator_1.createDocumentSchema), controller.createDocument);
router.put('/:id', admin_middleware_1.adminMiddleware, (0, validate_middleware_1.validate)(knowledge_validator_1.updateDocumentSchema), controller.updateDocument);
router.delete('/:id', admin_middleware_1.adminMiddleware, controller.deleteDocument);
exports.default = router;
//# sourceMappingURL=knowledge.routes.js.map
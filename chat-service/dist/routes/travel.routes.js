"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const travel_controller_1 = require("../controllers/travel.controller");
const auth_middleware_1 = require("../middleware/auth.middleware");
const router = (0, express_1.Router)();
// Travel AI Assistant — stateless streaming endpoint
router.post('/stream', auth_middleware_1.authMiddleware, travel_controller_1.postTravelStream);
exports.default = router;
//# sourceMappingURL=travel.routes.js.map
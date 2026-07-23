"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const envValidator_1 = require("../config/envValidator");
const ApiError_1 = require("../utils/ApiError");
exports.rateLimiter = (0, express_rate_limit_1.default)({
    windowMs: envValidator_1.env.RATE_LIMIT_WINDOW_MS,
    max: envValidator_1.env.RATE_LIMIT_MAX,
    standardHeaders: true, // Return standard rate limit info headers
    legacyHeaders: false, // Disable X-RateLimit-* headers
    handler: (_req, _res, next) => {
        next(new ApiError_1.ApiError(429, 'Too many requests from this client. Please try again later.'));
    },
});
exports.default = exports.rateLimiter;
//# sourceMappingURL=rateLimiter.middleware.js.map
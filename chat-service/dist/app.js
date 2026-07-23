"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const envValidator_1 = require("./config/envValidator");
const logger_1 = require("./config/logger");
const error_middleware_1 = require("./middleware/error.middleware");
const rateLimiter_middleware_1 = require("./middleware/rateLimiter.middleware");
const health_routes_1 = __importDefault(require("./routes/health.routes"));
const index_1 = __importDefault(require("./routes/index"));
const ApiError_1 = require("./utils/ApiError");
const app = (0, express_1.default)();
exports.app = app;
// 1. Security Headers
app.use((0, helmet_1.default)());
// 2. CORS configuration
app.use((0, cors_1.default)({
    origin: envValidator_1.env.CORS_ORIGIN === '*' ? '*' : envValidator_1.env.CORS_ORIGIN.split(','),
    credentials: true,
}));
// 3. Body parsers
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
// 4. Gzip compression
app.use((0, compression_1.default)());
// 5. HTTP request logging via Winston
const morganFormat = envValidator_1.env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use((0, morgan_1.default)(morganFormat, {
    stream: {
        write: (message) => logger_1.logger.info(message.trim()),
    },
}));
// 6. Global Rate Limiter
app.use(rateLimiter_middleware_1.rateLimiter);
// 7. Mount Root Routes
app.use('/health', health_routes_1.default); // GET /health
app.use('/api/v1', index_1.default); // GET /api/v1/health, etc.
// 8. 404 handler for unmatched routes
app.use((_req, _res, next) => {
    next(new ApiError_1.ApiError(404, 'API endpoint not found'));
});
// 9. Global Error handler middleware (must be registered last)
app.use(error_middleware_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map
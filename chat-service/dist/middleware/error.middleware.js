"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = void 0;
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../config/logger");
const errorHandler = (err, req, res, _next) => {
    let statusCode = 500;
    let message = 'Internal Server Error';
    let details = null;
    if (err instanceof ApiError_1.ApiError) {
        statusCode = err.statusCode;
        message = err.message;
        details = err.details;
    }
    else {
        // Standard system errors
        logger_1.logger.error(`Uncaught Error: ${err.message}`, { stack: err.stack, path: req.path });
    }
    // Include stack trace in development
    const responsePayload = {
        success: false,
        error: {
            message,
            statusCode,
            ...(details && { details }),
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
        },
    };
    // Log warn for client mistakes (4xx) and error for server problems (5xx)
    if (statusCode >= 500) {
        logger_1.logger.error(`${req.method} ${req.path} failed with status ${statusCode}: ${err.message}`);
    }
    else {
        logger_1.logger.warn(`${req.method} ${req.path} client error ${statusCode}: ${err.message}`);
    }
    res.status(statusCode).json(responsePayload);
};
exports.errorHandler = errorHandler;
exports.default = exports.errorHandler;
//# sourceMappingURL=error.middleware.js.map
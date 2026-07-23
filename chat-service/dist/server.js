"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const envValidator_1 = require("./config/envValidator");
const logger_1 = require("./config/logger");
const db_1 = require("./config/db");
const scheduler_service_1 = require("./services/scheduler.service");
// Establish Database Connection
(0, db_1.connectDB)().then(() => {
    const server = app_1.default.listen(envValidator_1.env.PORT, () => {
        logger_1.logger.info(`🚀 standalone AI Chat Service running in [${envValidator_1.env.NODE_ENV}] mode on port ${envValidator_1.env.PORT}`);
        // Start automatic synchronization scheduler
        scheduler_service_1.schedulerService.initialize().catch((err) => {
            logger_1.logger.error('Failed to initialize sync scheduler:', err);
        });
    });
    // Process-wide Uncaught Exception Handler
    process.on('uncaughtException', (error) => {
        logger_1.logger.error('CRITICAL: Uncaught Exception detected!', error);
        // Give files/logs a brief moment to write out before exit
        process.exit(1);
    });
    // Process-wide Unhandled Rejection Handler
    process.on('unhandledRejection', (reason) => {
        logger_1.logger.error('CRITICAL: Unhandled Rejection detected!', reason);
    });
    // Graceful Shutdown on Term signals
    const gracefulShutdown = (signal) => {
        logger_1.logger.info(`Received ${signal}. Shutting down server gracefully...`);
        // Stop sync intervals
        scheduler_service_1.schedulerService.shutdown();
        server.close(() => {
            logger_1.logger.info('HTTP server closed. Process exiting.');
            process.exit(0);
        });
        // Force close after 10s if connections linger
        setTimeout(() => {
            logger_1.logger.error('Could not close connections in time, forcefully shutting down');
            process.exit(1);
        }, 10000);
    };
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});
//# sourceMappingURL=server.js.map
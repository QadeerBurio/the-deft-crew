import app from './app';
import { env } from './config/envValidator';
import { logger } from './config/logger';
import { connectDB } from './config/db';
import { schedulerService } from './services/scheduler.service';

// Establish Database Connection
connectDB().then(() => {
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 standalone AI Chat Service running in [${env.NODE_ENV}] mode on port ${env.PORT}`);
    // Start automatic synchronization scheduler
    schedulerService.initialize().catch((err) => {
      logger.error('Failed to initialize sync scheduler:', err);
    });
  });

  // Process-wide Uncaught Exception Handler
  process.on('uncaughtException', (error: Error) => {
    logger.error('CRITICAL: Uncaught Exception detected!', error);
    // Give files/logs a brief moment to write out before exit
    process.exit(1);
  });

  // Process-wide Unhandled Rejection Handler
  process.on('unhandledRejection', (reason: any) => {
    logger.error('CRITICAL: Unhandled Rejection detected!', reason);
  });

  // Graceful Shutdown on Term signals
  const gracefulShutdown = (signal: string) => {
    logger.info(`Received ${signal}. Shutting down server gracefully...`);
    
    // Stop sync intervals
    schedulerService.shutdown();
    
    server.close(() => {
      logger.info('HTTP server closed. Process exiting.');
      process.exit(0);
    });

    // Force close after 10s if connections linger
    setTimeout(() => {
      logger.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
});


import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { env } from './config/envValidator';
import { logger } from './config/logger';
import { errorHandler } from './middleware/error.middleware';
import { rateLimiter } from './middleware/rateLimiter.middleware';
import healthRoutes from './routes/health.routes';
import v1Routes from './routes/index';
import { ApiError } from './utils/ApiError';

const app = express();

// 1. Security Headers
app.use(helmet());

// 2. CORS configuration
app.use(
  cors({
    origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(','),
    credentials: true,
  }),
);

// 3. Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 4. Gzip compression
app.use(compression());

// 5. HTTP request logging via Winston
const morganFormat = env.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use(
  morgan(morganFormat, {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  }),
);

// 6. Global Rate Limiter
app.use(rateLimiter);

// 7. Mount Root Routes
app.use('/health', healthRoutes); // GET /health
app.use('/api/v1', v1Routes); // GET /api/v1/health, etc.

// 8. 404 handler for unmatched routes
app.use((_req, _res, next) => {
  next(new ApiError(404, 'API endpoint not found'));
});

// 9. Global Error handler middleware (must be registered last)
app.use(errorHandler);

export default app;
export { app };

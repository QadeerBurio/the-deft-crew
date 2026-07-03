import rateLimit from 'express-rate-limit';
import { env } from '../config/envValidator';
import { ApiError } from '../utils/ApiError';

export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true, // Return standard rate limit info headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: (_req, _res, next) => {
    next(new ApiError(429, 'Too many requests from this client. Please try again later.'));
  },
});

export default rateLimiter;

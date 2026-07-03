import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { logger } from '../config/logger';

export const errorHandler = (
  err: Error | ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details: any = null;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else {
    // Standard system errors
    logger.error(`Uncaught Error: ${err.message}`, { stack: err.stack, path: req.path });
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
    logger.error(`${req.method} ${req.path} failed with status ${statusCode}: ${err.message}`);
  } else {
    logger.warn(`${req.method} ${req.path} client error ${statusCode}: ${err.message}`);
  }

  res.status(statusCode).json(responsePayload);
};

export default errorHandler;

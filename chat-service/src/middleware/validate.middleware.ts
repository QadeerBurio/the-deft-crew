import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';

export const validate = (schema: AnyZodObject) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      
      // Re-assign parsed inputs to request for safety & typing if validated in schema
      if (parsed.body !== undefined) {
        req.body = parsed.body;
      }
      if (parsed.query !== undefined) {
        req.query = parsed.query;
      }
      if (parsed.params !== undefined) {
        req.params = parsed.params;
      }
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        // Build clear validation feedback
        const errorDetails = error.errors.map((err) => ({
          field: err.path.slice(1).join('.'), // Remove top-level body/query/params key
          message: err.message,
        }));
        
        next(new ApiError(400, 'Validation Failed', errorDetails));
      } else {
        next(error);
      }
    }
  };
};

export default validate;

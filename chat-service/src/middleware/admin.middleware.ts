import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.middleware';

export const adminMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Access denied. Admins only.' });
    return;
  }
  next();
};

export default adminMiddleware;

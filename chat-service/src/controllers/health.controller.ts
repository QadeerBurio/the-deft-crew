import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';

export const getHealth = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    service: 'tdc-chat-service',
    status: 'healthy',
    version: '1.0.0',
  });
});
export default getHealth;

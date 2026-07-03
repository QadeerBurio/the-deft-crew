import { Request, Response } from 'express';
import { syncService } from '../services/sync.service';
import { asyncHandler } from '../utils/asyncHandler';

export const syncSourceData = asyncHandler(async (req: Request, res: Response) => {
  const { source } = req.params;
  const result = await syncService.syncSource(source, req.body);
  
  res.status(200).json({
    success: true,
    message: `Data synchronized successfully for source: ${source}`,
    data: result,
  });
});

export default syncSourceData;

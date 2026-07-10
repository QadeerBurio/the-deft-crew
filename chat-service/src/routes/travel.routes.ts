import { Router } from 'express';
import { postTravelStream } from '../controllers/travel.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Travel AI Assistant — stateless streaming endpoint
router.post('/stream', authMiddleware, postTravelStream);

export default router;

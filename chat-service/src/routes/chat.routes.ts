import { Router } from 'express';
import * as controller from '../controllers/chat.controller';
import { validate } from '../middleware/validate.middleware';
import { chatMessageSchema } from '../validators/chat.validator';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/message', authMiddleware, validate(chatMessageSchema), controller.postMessage);
router.post('/stream', authMiddleware, validate(chatMessageSchema), controller.postStream);
router.get('/sessions', authMiddleware, controller.getSessions);
router.get('/history/:sessionId', authMiddleware, controller.getHistory);
router.delete('/session/:sessionId', authMiddleware, controller.deleteSession);
router.post('/title', authMiddleware, controller.updateTitle);
router.get('/suggestions', authMiddleware, controller.getSuggestions);
router.get('/status', authMiddleware, controller.getStatus);

export default router;

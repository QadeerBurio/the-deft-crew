import { Router } from 'express';
import healthRoutes from './health.routes';
import chatRoutes from './chat.routes';
import knowledgeRoutes from './knowledge.routes';
import syncRoutes from './sync.routes';

const router = Router();

// Mount individual domain sub-routers
router.use('/health', healthRoutes);
router.use('/chat', chatRoutes);
router.use('/knowledge', knowledgeRoutes);
router.use('/sync', syncRoutes);

export default router;

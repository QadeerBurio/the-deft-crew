import { Router } from 'express';
import * as controller from '../controllers/knowledge.controller';
import { validate } from '../middleware/validate.middleware';
import { createDocumentSchema, updateDocumentSchema } from '../validators/knowledge.validator';
import { authMiddleware } from '../middleware/auth.middleware';
import { adminMiddleware } from '../middleware/admin.middleware';

const router = Router();

// Protect all knowledge base endpoints with authentication
router.use(authMiddleware);

// Vector search and statistics routes (register these before GET /:id to prevent parameter conflict)
router.get('/statistics', adminMiddleware, controller.getStatistics);
router.post('/search', controller.searchKnowledge);
router.post('/reindex', adminMiddleware, controller.reindexAll);
router.post('/reindex/:id', adminMiddleware, controller.reindexDocument);

// General REST routes
router.get('/', controller.listDocuments);
router.get('/:id', controller.getDocument);
router.post('/', adminMiddleware, validate(createDocumentSchema), controller.createDocument);
router.put('/:id', adminMiddleware, validate(updateDocumentSchema), controller.updateDocument);
router.delete('/:id', adminMiddleware, controller.deleteDocument);

export default router;

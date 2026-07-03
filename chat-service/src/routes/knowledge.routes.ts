import { Router } from 'express';
import * as controller from '../controllers/knowledge.controller';
import { validate } from '../middleware/validate.middleware';
import { createDocumentSchema, updateDocumentSchema } from '../validators/knowledge.validator';

const router = Router();

// Vector search and statistics routes (register these before GET /:id to prevent parameter conflict)
router.get('/statistics', controller.getStatistics);
router.post('/search', controller.searchKnowledge);
router.post('/reindex', controller.reindexAll);
router.post('/reindex/:id', controller.reindexDocument);

// General REST routes
router.get('/', controller.listDocuments);
router.get('/:id', controller.getDocument);
router.post('/', validate(createDocumentSchema), controller.createDocument);
router.put('/:id', validate(updateDocumentSchema), controller.updateDocument);
router.delete('/:id', controller.deleteDocument);

export default router;

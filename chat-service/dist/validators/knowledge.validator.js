"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateDocumentSchema = exports.createDocumentSchema = void 0;
const zod_1 = require("zod");
exports.createDocumentSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string({ required_error: 'Title is required' }).trim().min(1, 'Title cannot be empty'),
        category: zod_1.z.string({ required_error: 'Category is required' }).trim().min(1, 'Category cannot be empty'),
        source: zod_1.z.string({ required_error: 'Source is required' }).trim().min(1, 'Source cannot be empty'),
        content: zod_1.z.string({ required_error: 'Content is required' }).trim().min(1, 'Content cannot be empty'),
        tags: zod_1.z.array(zod_1.z.string()).default([]),
        status: zod_1.z.enum(['draft', 'published', 'archived']).default('published'),
        metadata: zod_1.z.record(zod_1.z.any()).default({}),
    }),
});
exports.updateDocumentSchema = zod_1.z.object({
    body: zod_1.z.object({
        title: zod_1.z.string().trim().min(1, 'Title cannot be empty').optional(),
        category: zod_1.z.string().trim().min(1, 'Category cannot be empty').optional(),
        source: zod_1.z.string().trim().min(1, 'Source cannot be empty').optional(),
        content: zod_1.z.string().trim().min(1, 'Content cannot be empty').optional(),
        tags: zod_1.z.array(zod_1.z.string()).optional(),
        status: zod_1.z.enum(['draft', 'published', 'archived']).optional(),
        metadata: zod_1.z.record(zod_1.z.any()).optional(),
    }),
});
//# sourceMappingURL=knowledge.validator.js.map
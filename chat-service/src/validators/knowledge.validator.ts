import { z } from 'zod';

export const createDocumentSchema = z.object({
  body: z.object({
    title: z.string({ required_error: 'Title is required' }).trim().min(1, 'Title cannot be empty'),
    category: z.string({ required_error: 'Category is required' }).trim().min(1, 'Category cannot be empty'),
    source: z.string({ required_error: 'Source is required' }).trim().min(1, 'Source cannot be empty'),
    content: z.string({ required_error: 'Content is required' }).trim().min(1, 'Content cannot be empty'),
    tags: z.array(z.string()).default([]),
    status: z.enum(['draft', 'published', 'archived']).default('published'),
    metadata: z.record(z.any()).default({}),
  }),
});

export const updateDocumentSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1, 'Title cannot be empty').optional(),
    category: z.string().trim().min(1, 'Category cannot be empty').optional(),
    source: z.string().trim().min(1, 'Source cannot be empty').optional(),
    content: z.string().trim().min(1, 'Content cannot be empty').optional(),
    tags: z.array(z.string()).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    metadata: z.record(z.any()).optional(),
  }),
});

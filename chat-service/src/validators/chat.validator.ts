import { z } from 'zod';

export const chatMessageSchema = z.object({
  body: z.object({
    message: z
      .string({
        required_error: 'Message is required',
        invalid_type_error: 'Message must be a string',
      })
      .trim()
      .min(1, 'Message cannot be empty')
      .max(2000, 'Message cannot exceed 2000 characters'),
    sessionId: z
      .string({
        invalid_type_error: 'Session ID must be a string',
      })
      .trim()
      .optional()
      .transform((val) => (val === '' ? undefined : val)),
  }),
});

export default chatMessageSchema;

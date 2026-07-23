"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatMessageSchema = void 0;
const zod_1 = require("zod");
exports.chatMessageSchema = zod_1.z.object({
    body: zod_1.z.object({
        message: zod_1.z
            .string({
            required_error: 'Message is required',
            invalid_type_error: 'Message must be a string',
        })
            .trim()
            .min(1, 'Message cannot be empty')
            .max(2000, 'Message cannot exceed 2000 characters'),
        sessionId: zod_1.z
            .string({
            invalid_type_error: 'Session ID must be a string',
        })
            .trim()
            .optional()
            .transform((val) => (val === '' ? undefined : val)),
    }),
});
exports.default = exports.chatMessageSchema;
//# sourceMappingURL=chat.validator.js.map
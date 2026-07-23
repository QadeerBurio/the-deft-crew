"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
// Load variables from .env
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().default(5001),
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    MONGO_URI: zod_1.z.string().url('MONGO_URI must be a valid connection string'),
    JWT_SECRET: zod_1.z.string().min(5, 'JWT_SECRET must be at least 5 characters long'),
    GEMINI_API_KEY: zod_1.z.string().optional(),
    OPENAI_API_KEY: zod_1.z.string().optional(),
    OPENAI_MODEL: zod_1.z.string().default('gpt-4o-mini'),
    OPENAI_MAX_OUTPUT_TOKENS: zod_1.z.coerce.number().default(3000),
    OPENAI_TEMPERATURE: zod_1.z.coerce.number().default(0.3),
    OPENAI_EMBEDDING_MODEL: zod_1.z.string().default('text-embedding-3-small'),
    TOP_K_RESULTS: zod_1.z.coerce.number().default(5),
    MAX_CONTEXT_DOCUMENTS: zod_1.z.coerce.number().default(5),
    MAX_CONTEXT_CHARACTERS: zod_1.z.coerce.number().default(12000),
    RATE_LIMIT_WINDOW_MS: zod_1.z.coerce.number().default(900000), // 15 minutes
    RATE_LIMIT_MAX: zod_1.z.coerce.number().default(100),
    CORS_ORIGIN: zod_1.z.string().default('*'),
    BACKEND_MONGO_URI: zod_1.z.string().url('BACKEND_MONGO_URI must be a valid connection string'),
    SYNC_INTERVAL_MINUTES: zod_1.z.coerce.number().default(30),
});
const parseEnv = () => {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        console.error('❌ Invalid environment configuration:');
        console.error(JSON.stringify(result.error.format(), null, 2));
        process.exit(1);
    }
    return result.data;
};
exports.env = parseEnv();
exports.default = exports.env;
//# sourceMappingURL=envValidator.js.map
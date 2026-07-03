import dotenv from 'dotenv';
import { z } from 'zod';

// Load variables from .env
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(5001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGO_URI: z.string().url('MONGO_URI must be a valid connection string'),
  JWT_SECRET: z.string().min(5, 'JWT_SECRET must be at least 5 characters long'),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().default(2000),
  OPENAI_TEMPERATURE: z.coerce.number().default(0.7),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  TOP_K_RESULTS: z.coerce.number().default(5),
  MAX_CONTEXT_DOCUMENTS: z.coerce.number().default(5),
  MAX_CONTEXT_CHARACTERS: z.coerce.number().default(12000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000), // 15 minutes
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  CORS_ORIGIN: z.string().default('*'),
  BACKEND_MONGO_URI: z.string().url('BACKEND_MONGO_URI must be a valid connection string'),
  SYNC_INTERVAL_MINUTES: z.coerce.number().default(30),
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

export const env = parseEnv();
export default env;

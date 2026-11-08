import { z } from 'zod';

const env = z
  .object({
    PORT: z.coerce.number().default(4000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    SESSION_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'SESSION_ENC_KEY must be 64 hex characters'),
    MAX_RECIPIENTS: z.coerce.number().int().positive().default(50),
    SEND_GAP_MIN_MS: z.coerce.number().int().nonnegative().default(2000),
    SEND_GAP_MAX_MS: z.coerce.number().int().nonnegative().default(6000),
    SEND_CONCURRENCY: z.coerce.number().int().positive().default(20),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  })
  .safeParse(process.env);

if (!env.success) {
  console.error('Invalid environment configuration:');
  for (const issue of env.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = {
  port: env.data.PORT,
  isProd: env.data.NODE_ENV === 'production',
  logLevel: env.data.LOG_LEVEL,
  databaseUrl: env.data.DATABASE_URL,
  jwtSecret: env.data.JWT_SECRET,
  sessionEncKey: Buffer.from(env.data.SESSION_ENC_KEY, 'hex'),
  maxRecipients: env.data.MAX_RECIPIENTS,
  sendGapMinMs: env.data.SEND_GAP_MIN_MS,
  sendGapMaxMs: Math.max(env.data.SEND_GAP_MIN_MS, env.data.SEND_GAP_MAX_MS),
  sendConcurrency: env.data.SEND_CONCURRENCY,
  pollIntervalMs: env.data.POLL_INTERVAL_MS,
};

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
    // AI auto-reply is available only when a key for the chosen provider is set.
    ANTHROPIC_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
    OPENAI_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
    GEMINI_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
    AI_PROVIDER: z
      .string()
      .optional()
      .transform((v) => v?.trim() || undefined)
      .pipe(z.enum(['anthropic', 'openai', 'gemini']).optional()),
    AI_MODEL: z.string().optional().transform((v) => v?.trim() || undefined),
    // Origins allowed to call the API from another origin: the Android app's WebView.
    APP_ORIGINS: z.string().default('https://localhost,capacitor://localhost'),
    // Shown on the privacy policy page (required for a Play Store listing).
    CONTACT_EMAIL: z.string().optional().transform((v) => v?.trim() || undefined),
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
  ai: aiConfig(),
  appOrigins: env.data.APP_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  contactEmail: env.data.CONTACT_EMAIL,
};

/**
 * Which AI provider writes auto-replies. AI_PROVIDER picks one explicitly; otherwise whichever key
 * is set wins (Anthropic, then OpenAI, then Gemini). Null means auto-reply is unavailable.
 */
function aiConfig() {
  const e = env.data!;
  const provider =
    e.AI_PROVIDER ??
    (e.ANTHROPIC_API_KEY ? 'anthropic' : e.OPENAI_API_KEY ? 'openai' : e.GEMINI_API_KEY ? 'gemini' : null);
  if (provider === 'anthropic' && e.ANTHROPIC_API_KEY) {
    return { provider, apiKey: e.ANTHROPIC_API_KEY, model: e.AI_MODEL ?? 'claude-opus-5-5' } as const;
  }
  if (provider === 'openai' && e.OPENAI_API_KEY) {
    return { provider, apiKey: e.OPENAI_API_KEY, model: e.AI_MODEL ?? 'gpt-6-luna' } as const;
  }
  if (provider === 'gemini' && e.GEMINI_API_KEY) {
    // Free tier on Google AI Studio keys (free-tier data may be used by Google to improve its products).
    return { provider, apiKey: e.GEMINI_API_KEY, model: e.AI_MODEL ?? 'gemini-3.5-flash-lite' } as const;
  }
  return null;
}

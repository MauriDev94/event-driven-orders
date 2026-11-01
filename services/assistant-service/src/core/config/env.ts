import { z } from 'zod';

export const SERVICE_NAME = 'assistant-service';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // `fake` runs without a key (the Compose default); `gemini` is the real model.
    LLM_PROVIDER: z.enum(['fake', 'gemini']).default('fake'),
    // Flash Lite for the free tier's daily quota (ADR-0022).
    LLM_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    // Compose passes an unset key as an empty string: that counts as missing.
    GEMINI_API_KEY: z
      .string()
      .optional()
      .transform((key) => (key === '' ? undefined : key)),
    ASK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(5),
    // Model calls per day, below the free tier's daily quota (ADR-0024).
    LLM_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(400),
    // Express `trust proxy`: which proxies may set X-Forwarded-For. `false`
    // uses the socket address; behind Caddy, `uniquelocal` (its private IP).
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((value) => (value === 'false' ? false : value)),
  })
  .superRefine((env, context) => {
    if (env.LLM_PROVIDER === 'gemini' && env.GEMINI_API_KEY === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEY'],
        message: 'required when LLM_PROVIDER is gemini',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment once, at startup. The error names the wrong
 * variables but never echoes their values: the URLs carry passwords, and
 * GEMINI_API_KEY is a secret.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}

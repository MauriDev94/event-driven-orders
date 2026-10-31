import { z } from 'zod';

export const SERVICE_NAME = 'assistant-service';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment once, at startup. The error names the wrong
 * variables but never echoes their values: the URLs carry passwords.
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

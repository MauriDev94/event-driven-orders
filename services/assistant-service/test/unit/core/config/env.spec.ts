import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../../../src/core/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://assistant@postgres-assistant:5432/assistant_db',
  RABBITMQ_URL: 'amqp://broker@rabbitmq:5672/',
  REDIS_URL: 'redis://default@redis:6379/0',
};

describe('loadEnv', () => {
  it('applies the defaults', () => {
    expect(loadEnv(valid)).toEqual({
      ...valid,
      PORT: 8000,
      LOG_LEVEL: 'info',
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'gemini-3.8-flash',
      ASK_RATE_LIMIT_PER_MINUTE: 5,
      TRUST_PROXY: false,
    });
  });

  it('reads PORT as a number', () => {
    expect(loadEnv({ ...valid, PORT: '9000' }).PORT).toBe(9000);
  });

  it('names the missing variable', () => {
    expect(() => loadEnv({ RABBITMQ_URL: valid.RABBITMQ_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a URL with the wrong scheme', () => {
    expect(() =>
      loadEnv({ ...valid, RABBITMQ_URL: 'http://rabbitmq:5672/' }),
    ).toThrow(/RABBITMQ_URL/);
    expect(() =>
      loadEnv({ ...valid, REDIS_URL: 'http://redis:6379/' }),
    ).toThrow(/REDIS_URL/);
  });

  it('requires GEMINI_API_KEY with the gemini provider', () => {
    expect(() => loadEnv({ ...valid, LLM_PROVIDER: 'gemini' })).toThrow(
      /GEMINI_API_KEY/,
    );
    // Compose passes an unset key as an empty string.
    expect(() =>
      loadEnv({ ...valid, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: '' }),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it('takes the gemini provider, its model and the limits', () => {
    const key = randomBytes(8).toString('hex');

    expect(
      loadEnv({
        ...valid,
        LLM_PROVIDER: 'gemini',
        LLM_MODEL: 'gemini-3.5-flash-lite',
        GEMINI_API_KEY: key,
        ASK_RATE_LIMIT_PER_MINUTE: '12',
        TRUST_PROXY: 'loopback, uniquelocal',
      }),
    ).toMatchObject({
      LLM_PROVIDER: 'gemini',
      LLM_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_API_KEY: key,
      ASK_RATE_LIMIT_PER_MINUTE: 12,
      TRUST_PROXY: 'loopback, uniquelocal',
    });
  });

  it('rejects an unknown provider', () => {
    expect(() => loadEnv({ ...valid, LLM_PROVIDER: 'other' })).toThrow(
      /LLM_PROVIDER/,
    );
  });

  it('never echoes the values, which carry passwords', () => {
    const secret = randomBytes(8).toString('hex');
    expect(() =>
      loadEnv({ ...valid, DATABASE_URL: `not a url ${secret}` }),
    ).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
    expect(() =>
      loadEnv({ ...valid, LLM_PROVIDER: 'other', GEMINI_API_KEY: secret }),
    ).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});

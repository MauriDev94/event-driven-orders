import { randomBytes, randomInt } from 'node:crypto';
import { loadEnv } from '../../../../src/core/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://assistant@postgres-assistant:5432/assistant_db',
  RABBITMQ_URL: 'amqp://broker@rabbitmq:5672/',
  REDIS_URL: 'redis://default@redis:6379/0',
  // Generated per run: no secret is written in the repo, not even a test one.
  AUTH_TOKEN_SECRET: randomBytes(32).toString('base64url'),
};

describe('loadEnv', () => {
  it('applies the defaults', () => {
    expect(loadEnv(valid)).toEqual({
      ...valid,
      PORT: 8000,
      LOG_LEVEL: 'info',
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'gemini-3.5-flash-lite',
      ASK_RATE_LIMIT_PER_MINUTE: 5,
      LLM_DAILY_CALL_LIMIT: 400,
      LLM_MINUTE_CALL_LIMIT: 15,
      TIMELINE_RATE_LIMIT_PER_MINUTE: 120,
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
        LLM_MODEL: 'gemini-3.8-flash',
        GEMINI_API_KEY: key,
        ASK_RATE_LIMIT_PER_MINUTE: '12',
        LLM_DAILY_CALL_LIMIT: '100',
        LLM_MINUTE_CALL_LIMIT: '10',
        TIMELINE_RATE_LIMIT_PER_MINUTE: '30',
        TRUST_PROXY: 'loopback, uniquelocal',
      }),
    ).toMatchObject({
      LLM_PROVIDER: 'gemini',
      LLM_MODEL: 'gemini-3.8-flash',
      GEMINI_API_KEY: key,
      ASK_RATE_LIMIT_PER_MINUTE: 12,
      LLM_DAILY_CALL_LIMIT: 100,
      LLM_MINUTE_CALL_LIMIT: 10,
      TIMELINE_RATE_LIMIT_PER_MINUTE: 30,
      TRUST_PROXY: 'loopback, uniquelocal',
    });
  });

  it('rejects an unknown provider', () => {
    expect(() => loadEnv({ ...valid, LLM_PROVIDER: 'other' })).toThrow(
      /LLM_PROVIDER/,
    );
  });

  describe('AUTH_TOKEN_SECRET', () => {
    const { AUTH_TOKEN_SECRET: _omitted, ...withoutSecret } = valid;

    it('is mandatory and has no default', () => {
      expect(() => loadEnv(withoutSecret)).toThrow(/AUTH_TOKEN_SECRET/);
      expect(() =>
        loadEnv({ ...withoutSecret, AUTH_TOKEN_SECRET: '' }),
      ).toThrow(/AUTH_TOKEN_SECRET/);
    });

    it('needs at least 32 bytes', () => {
      const secret = randomBytes(16).toString('hex');
      expect(Buffer.byteLength(secret)).toBe(32);
      expect(() =>
        loadEnv({ ...valid, AUTH_TOKEN_SECRET: secret.slice(0, 31) }),
      ).toThrow(/AUTH_TOKEN_SECRET/);
      expect(
        loadEnv({ ...valid, AUTH_TOKEN_SECRET: secret }).AUTH_TOKEN_SECRET,
      ).toBe(secret);
    });

    it('measures bytes, not characters', () => {
      // Random 2-byte characters: 16 of them are 32 bytes, 15 are 30.
      const twoBytes = (count: number) =>
        Array.from({ length: count }, () => 'éñüö'[randomInt(4)]).join('');
      const enough = twoBytes(16);
      expect(Buffer.byteLength(enough)).toBe(32);
      expect(enough).toHaveLength(16);
      expect(
        loadEnv({ ...valid, AUTH_TOKEN_SECRET: enough }).AUTH_TOKEN_SECRET,
      ).toBe(enough);
      expect(() =>
        loadEnv({ ...valid, AUTH_TOKEN_SECRET: twoBytes(15) }),
      ).toThrow(/AUTH_TOKEN_SECRET/);
    });

    it('never appears in the validation error', () => {
      const secret = randomBytes(8).toString('hex');
      expect(secret.length).toBeLessThan(32);
      expect(() =>
        loadEnv({ ...valid, AUTH_TOKEN_SECRET: secret, PORT: 'not a number' }),
      ).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(secret),
        }),
      );
      expect(() => loadEnv({ ...valid, AUTH_TOKEN_SECRET: secret })).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(secret),
        }),
      );
    });
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

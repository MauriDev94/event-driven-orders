import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../../../src/core/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://assistant@postgres-assistant:5432/assistant_db',
  RABBITMQ_URL: 'amqp://broker@rabbitmq:5672/',
};

describe('loadEnv', () => {
  it('applies the defaults', () => {
    expect(loadEnv(valid)).toEqual({ ...valid, PORT: 8000, LOG_LEVEL: 'info' });
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
  });

  it('never echoes the values, which carry passwords', () => {
    const secret = randomBytes(8).toString('hex');
    expect(() =>
      loadEnv({ ...valid, DATABASE_URL: `not a url ${secret}` }),
    ).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });
});

import { randomBytes } from 'node:crypto';
import {
  InvalidTokenError,
  sessionKey,
  verifySessionToken,
} from '../../../../src/core/auth/session-token.js';
import {
  refusedAuthorizations,
  signTestToken,
  TEST_AUTH_SECRET,
} from '../../../support/session-token.js';

describe('verifySessionToken', () => {
  const key = sessionKey(TEST_AUTH_SECRET);
  const now = Math.floor(Date.now() / 1000);

  it('returns the customer id of a valid token', async () => {
    await expect(verifySessionToken(signTestToken('c-1'), key)).resolves.toBe(
      'c-1',
    );
  });

  it('accepts the longest customer id and every allowed character', async () => {
    const id = `A${'b.c_d-1'.repeat(5)}`.slice(0, 36);
    expect(id).toHaveLength(36);
    await expect(verifySessionToken(signTestToken(id), key)).resolves.toBe(id);
  });

  describe('clock tolerance (30 s, like the PyJWT leeway)', () => {
    it.each([
      ['an exp 29 s in the past', { exp: now - 29 }],
      ['an iat 29 s in the future', { iat: now + 29, exp: now + 3600 }],
      ['an nbf 29 s in the future', { nbf: now + 29 }],
    ])('accepts %s', async (_name, claims) => {
      await expect(
        verifySessionToken(signTestToken('c-1', { claims }), key),
      ).resolves.toBe('c-1');
    });

    it.each([
      ['an exp 31 s in the past', { exp: now - 31 }],
      ['an iat 31 s in the future', { iat: now + 31, exp: now + 3600 }],
    ])('refuses %s', async (_name, claims) => {
      await expect(
        verifySessionToken(signTestToken('c-1', { claims }), key),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('measures the tolerance against the clock it is given', async () => {
      const token = signTestToken('c-1', { claims: { exp: now + 60 } });
      const later = new Date((now + 200) * 1000);
      await expect(
        verifySessionToken(token, key, later),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });

  describe('lifetime (SEC94-06)', () => {
    const SEVEN_DAYS = 7 * 24 * 3600;

    it.each([
      ['what order-service issues: exactly 7 days', SEVEN_DAYS],
      ['7 days plus the 30 s tolerance', SEVEN_DAYS + 30],
      ['one hour', 3600],
    ])('accepts %s', async (_name, lifetime) => {
      const token = signTestToken('c-1', {
        claims: { iat: now, exp: now + lifetime },
      });

      await expect(verifySessionToken(token, key)).resolves.toBe('c-1');
    });

    it('refuses a lifetime past 7 days plus the tolerance', async () => {
      const token = signTestToken('c-1', {
        claims: { iat: now, exp: now + SEVEN_DAYS + 31 },
      });

      await expect(verifySessionToken(token, key)).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
    });

    it('refuses an exp that is not finite, which would never expire', async () => {
      const token = signTestToken('c-1', {
        claims: { exp: 1 },
        transformPayload: (json) => json.replace('"exp":1', '"exp":1e400'),
      });

      await expect(verifySessionToken(token, key)).rejects.toBeInstanceOf(
        InvalidTokenError,
      );
    });
  });

  it('accepts an aud list that includes ours, like PyJWT', async () => {
    const token = signTestToken('c-1', {
      claims: { aud: ['someone-else', 'event-driven-orders'] },
    });

    await expect(verifySessionToken(token, key)).resolves.toBe('c-1');
  });

  it('reads typ from the payload, not from the JOSE header', async () => {
    // jose's `typ` option checks the header; ours is a payload claim.
    const headerOnly = signTestToken('c-1', {
      claims: { typ: undefined },
      header: { typ: 'session' },
    });
    await expect(verifySessionToken(headerOnly, key)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
    const payloadOnly = signTestToken('c-1', { header: { typ: 'at+jwt' } });
    await expect(verifySessionToken(payloadOnly, key)).resolves.toBe('c-1');
  });

  it.each(
    refusedAuthorizations().filter((entry) =>
      entry.authorization?.startsWith('Bearer '),
    ),
  )('refuses a token with $name', async ({ authorization }) => {
    const token = (authorization ?? '').slice('Bearer '.length);
    await expect(verifySessionToken(token, key)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('gives every failure the same error, with no detail', async () => {
    const messages = new Set<string>();
    for (const token of [
      'garbage',
      signTestToken('c-1', { secret: randomBytes(32).toString('base64url') }),
      signTestToken('c-1', { claims: { exp: now - 3600 } }),
      signTestToken('c-1', { claims: { sub: 'a b' } }),
    ]) {
      const error = await verifySessionToken(token, key).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(InvalidTokenError);
      messages.add((error as Error).message);
    }
    expect([...messages]).toEqual(['Invalid or missing token']);
  });
});

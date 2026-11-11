import { createHmac, randomBytes } from 'node:crypto';

/**
 * A secret of this test process: generated at import, never written down.
 * `createTestApp` configures the service with it, so `signTestToken` tokens
 * are the ones the guard accepts.
 */
export const TEST_AUTH_SECRET = randomBytes(32).toString('base64url');

export interface TokenOptions {
  /** Signing secret; the process secret by default. */
  secret?: string;
  /** `none` signs nothing (an unsecured JWT). */
  alg?: 'HS256' | 'HS384' | 'HS512' | 'none';
  /** Merged over the valid claims; a key set to `undefined` is removed. */
  claims?: Record<string, unknown>;
  /** Merged over the header. */
  header?: Record<string, unknown>;
  /** Seconds since the epoch used for `iat`; the current time by default. */
  now?: number;
  /** Rewrites the payload JSON before it is signed (for values JSON.stringify can't write, like 1e400). */
  transformPayload?: (json: string) => string;
}

const HASHES = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' } as const;

function base64url(value: unknown, transform = (json: string) => json): string {
  return Buffer.from(transform(JSON.stringify(value))).toString('base64url');
}

/**
 * Signs a session token the way order-service issues it (ADR-0027), by hand,
 * so a test can break any part of it: the algorithm, a claim, the header.
 */
export function signTestToken(
  customerId: string,
  options: TokenOptions = {},
): string {
  const alg = options.alg ?? 'HS256';
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: 'order-service',
    aud: 'event-driven-orders',
    sub: customerId,
    iat: now,
    exp: now + 3600,
    typ: 'session',
    ...options.claims,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[name];
  }
  const signingInput = `${base64url({ alg, typ: 'JWT', ...options.header })}.${base64url(claims, options.transformPayload)}`;
  if (alg === 'none') return `${signingInput}.`;
  const signature = createHmac(HASHES[alg], options.secret ?? TEST_AUTH_SECRET)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/** The `Authorization` header value of a valid session token. */
export function bearer(customerId: string): string {
  return `Bearer ${signTestToken(customerId)}`;
}

export interface TokenCase {
  name: string;
  /** The `Authorization` header, or undefined for none. */
  authorization: string | undefined;
}

const SEVEN_DAYS = 7 * 24 * 3600;

/** Every way a token or its header can be wrong; all of them must be refused. */
export function refusedAuthorizations(customerId = 'c-1'): TokenCase[] {
  const withClaims = (claims: Record<string, unknown>): string =>
    `Bearer ${signTestToken(customerId, { claims })}`;
  const now = Math.floor(Date.now() / 1000);
  const missing = (claim: string): TokenCase => ({
    name: `${claim} missing`,
    authorization: withClaims({ [claim]: undefined }),
  });
  const tampered = (): string => {
    const [header, , signature] = signTestToken(customerId).split('.');
    const forged = base64url({ sub: 'someone-else' });
    return `Bearer ${header}.${forged}.${signature}`;
  };
  return [
    { name: 'no header', authorization: undefined },
    { name: 'empty header', authorization: '' },
    { name: 'bare Bearer', authorization: 'Bearer' },
    { name: 'Bearer with a space only', authorization: 'Bearer ' },
    {
      name: 'Basic scheme',
      authorization: `Basic ${randomBytes(12).toString('base64')}`,
    },
    {
      name: 'valid token under another scheme',
      authorization: `Token ${signTestToken(customerId)}`,
    },
    { name: 'garbage', authorization: 'Bearer not-a-token' },
    { name: 'two segments', authorization: 'Bearer aaa.bbb' },
    {
      name: 'bad signature',
      authorization: `Bearer ${signTestToken(customerId, { secret: randomBytes(32).toString('base64url') })}`,
    },
    { name: 'tampered payload', authorization: tampered() },
    {
      name: 'alg none',
      authorization: `Bearer ${signTestToken(customerId, { alg: 'none' })}`,
    },
    {
      name: 'HS512 signed with the right secret',
      authorization: `Bearer ${signTestToken(customerId, { alg: 'HS512' })}`,
    },
    {
      name: 'HS384 signed with the right secret',
      authorization: `Bearer ${signTestToken(customerId, { alg: 'HS384' })}`,
    },
    { name: 'wrong aud', authorization: withClaims({ aud: 'someone-else' }) },
    { name: 'wrong iss', authorization: withClaims({ iss: 'someone-else' }) },
    {
      name: 'aud as a list without ours',
      authorization: withClaims({ aud: ['a', 'b'] }),
    },
    {
      name: 'expired',
      authorization: withClaims({ exp: now - 3600, iat: now - 7200 }),
    },
    {
      name: 'expired beyond the tolerance',
      authorization: withClaims({ exp: now - 31 }),
    },
    { name: 'exp not a number', authorization: withClaims({ exp: 'soon' }) },
    { name: 'wrong typ', authorization: withClaims({ typ: 'refresh' }) },
    { name: 'typ not a string', authorization: withClaims({ typ: 1 }) },
    missing('typ'),
    missing('exp'),
    missing('iat'),
    missing('iss'),
    missing('aud'),
    missing('sub'),
    {
      name: 'iat in the future',
      authorization: withClaims({ iat: now + 3600, exp: now + 7200 }),
    },
    {
      name: 'iat just beyond the tolerance',
      authorization: withClaims({ iat: now + 40, exp: now + 7200 }),
    },
    {
      name: 'a lifetime beyond 7 days plus the tolerance',
      authorization: withClaims({ iat: now, exp: now + SEVEN_DAYS + 31 }),
    },
    {
      name: 'an exp that is not finite (1e400)',
      authorization: `Bearer ${signTestToken(customerId, { claims: { exp: 1 }, transformPayload: (json) => json.replace('"exp":1', '"exp":1e400') })}`,
    },
    { name: 'iat not a number', authorization: withClaims({ iat: 'now' }) },
    {
      name: 'nbf in the future',
      authorization: withClaims({ nbf: now + 3600 }),
    },
    {
      name: 'sub with bad characters',
      authorization: withClaims({ sub: 'a b/c' }),
    },
    {
      name: 'sub starting with a dash',
      authorization: withClaims({ sub: '-abc' }),
    },
    {
      name: 'sub with a trailing newline',
      authorization: withClaims({ sub: 'abc\n' }),
    },
    { name: 'empty sub', authorization: withClaims({ sub: '' }) },
    {
      name: 'sub of 37 characters',
      authorization: withClaims({ sub: 'a'.repeat(37) }),
    },
    { name: 'sub not a string', authorization: withClaims({ sub: 42 }) },
    { name: 'sub as a list', authorization: withClaims({ sub: ['c-1'] }) },
  ];
}

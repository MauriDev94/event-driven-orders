import { jwtVerify } from 'jose';
import { idSchema } from '../identifiers.js';

/**
 * The session token of ADR-0027, verified with the same rules as
 * order-service's `JwtTokenVerifier` (PyJWT). The fixed values mirror
 * `app/features/session/domain/token_claims.py` by hand; a CI job issues a
 * token with the real Python issuer and verifies it with this code.
 */
export const SESSION_ISSUER = 'order-service';
export const SESSION_AUDIENCE = 'event-driven-orders';
export const SESSION_TOKEN_TYPE = 'session';
export const SESSION_ALGORITHM = 'HS256';
/** Clock skew tolerated on `exp`, `nbf` and `iat`, in seconds. */
export const CLOCK_TOLERANCE_SECONDS = 30;
/** order-service issues tokens that live 7 days (`TOKEN_TTL_SECONDS`). */
export const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 3600;
/** One message for every failure: it must not tell which check failed. */
export const INVALID_TOKEN_MESSAGE = 'Invalid or missing token';

const REQUIRED_CLAIMS = ['exp', 'iat', 'iss', 'aud', 'sub', 'typ'];

/** The token is missing, malformed, forged, expired or not a session. */
export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';

  constructor(cause?: unknown) {
    super(INVALID_TOKEN_MESSAGE, { cause });
  }
}

/** The HMAC key of a secret: its UTF-8 bytes, like PyJWT's str key. */
export function sessionKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Returns the customer id (`sub`) of a valid session token. Every failure is
 * the same `InvalidTokenError`, whatever the cause (`cause` keeps it for a
 * debugger, never for a response).
 *
 * jose differs from PyJWT in a few places that this function closes:
 * - `typ` option of `jwtVerify` reads the JOSE *header*; ours is a payload
 *   claim, so it is compared here.
 * - `exp` must be finite and within the issuer's lifetime (checked by hand).
 * - jose ignores `iat` unless `maxTokenAge` is set; PyJWT refuses an `iat`
 *   more than the leeway in the future. `maxTokenAge` would also bound the
 *   token's age, which PyJWT does not, so the check is made by hand.
 */
export async function verifySessionToken(
  token: string,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [SESSION_ALGORITHM],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: REQUIRED_CLAIMS,
      currentDate: now,
    });
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const { iat, exp, typ, sub } = payload;
    if (typeof iat !== 'number' || iat > nowSeconds + CLOCK_TOLERANCE_SECONDS) {
      throw new Error('iat');
    }
    // `exp: 1e400` parses to Infinity and never expires; a lifetime longer than
    // the issuer's contract is not a token order-service made.
    if (
      typeof exp !== 'number' ||
      !Number.isFinite(exp) ||
      exp - iat > MAX_TOKEN_LIFETIME_SECONDS + CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error('exp');
    }
    if (typ !== SESSION_TOKEN_TYPE) throw new Error('typ');
    // The subject ends up in the read model's filters: one that breaks the id
    // rules is refused like a forged token.
    const subject = idSchema.safeParse(sub);
    if (!subject.success) throw new Error('sub');
    return subject.data;
  } catch (cause) {
    throw new InvalidTokenError(cause);
  }
}

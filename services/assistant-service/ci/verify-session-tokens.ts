/**
 * The other half of the CI check of ADR-0027 (section 7): verifies, with the
 * guard's own code, the tokens that order-service's real issuer wrote.
 *
 *   AUTH_TOKEN_SECRET=<secret> npx tsx ci/verify-session-tokens.ts <dir> <customer_id>
 *
 * `valid.token` must verify and give back the customer id; `forged.token`
 * (signed with another secret) must be refused. Prints only a verdict: neither
 * the secret nor the tokens may reach the CI log.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  InvalidTokenError,
  sessionKey,
  verifySessionToken,
} from '../src/core/auth/session-token.js';

const [directory, expected] = process.argv.slice(2);
const secret = process.env['AUTH_TOKEN_SECRET'];
if (directory === undefined || expected === undefined || !secret) {
  console.error(
    'usage: AUTH_TOKEN_SECRET=... verify-session-tokens <dir> <customer_id>',
  );
  process.exit(2);
}
const key = sessionKey(secret);
const read = (name: string): string =>
  readFileSync(join(directory, name), 'utf8').trim();

let subject: string | undefined;
try {
  subject = await verifySessionToken(read('valid.token'), key);
} catch (error) {
  if (!(error instanceof InvalidTokenError)) throw error;
}
if (subject === undefined) {
  console.error('FAIL: the token of order-service was refused');
  process.exit(1);
}
if (subject !== expected) {
  console.error('FAIL: the valid token gave another customer id');
  process.exit(1);
}

try {
  await verifySessionToken(read('forged.token'), key);
  console.error('FAIL: a token signed with another secret was accepted');
  process.exit(1);
} catch (error) {
  if (!(error instanceof InvalidTokenError)) throw error;
}

console.log('ok: the token of order-service verifies, a forged one does not');

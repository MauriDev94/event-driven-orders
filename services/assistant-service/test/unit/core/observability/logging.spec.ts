import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { type Options, pinoHttp } from 'pino-http';
import request from 'supertest';
import { loggerParams } from '../../../../src/core/observability/logging.js';
import { signTestToken } from '../../../support/session-token.js';

describe('request logs', () => {
  it('never contain the bearer token or the cookies (SEC-06)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const options = loggerParams({ LOG_LEVEL: 'info' }).pinoHttp as Options;
    const log = pinoHttp(options, sink);
    const server = createServer((req, res) => {
      log(req, res);
      res.end('ok');
    });
    const token = signTestToken('c-1');
    const cookie = randomBytes(16).toString('hex');

    await request(server)
      .get('/v1/assistant/orders/o-1/timeline')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', `session=${cookie}`)
      .expect(200);

    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    const output = lines.join('');
    expect(output).toContain('/v1/assistant/orders/o-1/timeline');
    expect(output).not.toContain(token);
    expect(output).not.toContain(cookie);
    const entry = JSON.parse(lines[0] ?? '{}') as {
      req: { headers: Record<string, string> };
    };
    expect(entry.req.headers['authorization']).toBe('[Redacted]');
    expect(entry.req.headers['cookie']).toBe('[Redacted]');
  });
});

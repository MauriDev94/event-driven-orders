import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { inject } from 'vitest';
import { RedisConnection } from '../../src/core/cache/redis.connection.js';
import { toProjectionCommand } from '../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../src/features/order-history/application/usecases/project-order-event.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { orderCreated, stockReserved } from '../support/order-events.js';
import { answer, ScriptedLlmClient } from '../support/scripted-llm-client.js';
import {
  bearer,
  refusedAuthorizations,
  signTestToken,
} from '../support/session-token.js';
import { createTestApp, randomIp } from '../support/test-app.js';

const ME = 'customer-me';
const OTHER = 'customer-other';
const INVALID = { message: 'Invalid or missing token' };

// ADR-0027: both routes verify the session, and a 401 is always the same.
describe('session auth and ownership', () => {
  let database: TestDatabase;
  let app: NestExpressApplication;
  let llm: ScriptedLlmClient;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    llm = new ScriptedLlmClient(
      Array.from({ length: 50 }, () => answer('hola')),
    );
    app = await createTestApp({
      databaseUrl: database.url,
      env: {
        ASK_RATE_LIMIT_PER_MINUTE: '2',
        TIMELINE_RATE_LIMIT_PER_MINUTE: '2',
        TRUST_PROXY: 'loopback',
      },
      llm,
    });
  });

  afterAll(async () => {
    await app?.close();
    await database.drop();
  });

  const ask = (authorization: string | undefined, ip = randomIp()) => {
    const call = request(app.getHttpServer())
      .post('/v1/assistant/ask')
      .set('X-Forwarded-For', ip);
    if (authorization !== undefined) call.set('Authorization', authorization);
    return call.send({ question: 'hola' });
  };

  const timeline = (
    authorization: string | undefined,
    orderId: string,
    ip = randomIp(),
  ) => {
    const call = request(app.getHttpServer())
      .get(`/v1/assistant/orders/${orderId}/timeline`)
      .set('X-Forwarded-For', ip);
    if (authorization !== undefined) call.set('Authorization', authorization);
    return call;
  };

  async function project(
    ...events: Parameters<typeof toProjectionCommand>[0][]
  ) {
    const projector = app.get(ProjectOrderEvent);
    for (const event of events) {
      await projector.execute(toProjectionCommand(event));
    }
  }

  describe.each(refusedAuthorizations(ME))(
    'with $name',
    ({ authorization }) => {
      it('answers the same 401 on /ask', async () => {
        const response = await ask(authorization).expect(401);

        expect(response.body).toEqual(INVALID);
        expect(response.headers['www-authenticate']).toBe('Bearer');
      });

      it('answers the same 401 on the timeline', async () => {
        const response = await timeline(authorization, randomUUID()).expect(
          401,
        );

        expect(response.body).toEqual(INVALID);
        expect(response.headers['www-authenticate']).toBe('Bearer');
      });
    },
  );

  it('never calls the model for a refused question', async () => {
    const before = llm.requests.length;

    await ask(undefined).expect(401);
    await ask('Bearer garbage').expect(401);

    expect(llm.requests.length).toBe(before);
  });

  it.each(['Bearer', 'bearer', 'BEARER'])(
    'takes the %s scheme in any case',
    async (scheme) => {
      const token = signTestToken(ME);

      await ask(`${scheme} ${token}`).expect(200);
      await timeline(`${scheme} ${token}`, randomUUID()).expect(404);
    },
  );

  it('accepts a clock skew within 30 seconds', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signTestToken(ME, {
      claims: { iat: now + 20, exp: now + 10 },
    });

    await ask(`Bearer ${token}`).expect(200);
  });

  describe('before the rate limit', () => {
    it('does not spend the /ask limit on a 401', async () => {
      const ip = randomIp();
      for (let i = 0; i < 5; i++) await ask(undefined, ip).expect(401);

      await ask(bearer(ME), ip).expect(200);
      await ask(bearer(ME), ip).expect(200);
      await ask(bearer(ME), ip).expect(429);
    });

    it('does not spend the timeline limit on a 401', async () => {
      const ip = randomIp();
      for (let i = 0; i < 5; i++) {
        await timeline('Bearer garbage', randomUUID(), ip).expect(401);
      }

      await timeline(bearer(ME), randomUUID(), ip).expect(404);
      await timeline(bearer(ME), randomUUID(), ip).expect(404);
      await timeline(bearer(ME), randomUUID(), ip).expect(429);
    });

    it('answers 401, not 429, to a client whose IP is over the limit', async () => {
      const ip = randomIp();
      await ask(bearer(ME), ip).expect(200);
      await ask(bearer(ME), ip).expect(200);
      await ask(bearer(ME), ip).expect(429);

      await ask(undefined, ip).expect(401);
    });
  });

  it('keeps /health and /metrics open', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/metrics').expect(200);
  });

  describe('the timeline belongs to its customer', () => {
    it('shows the order to its owner', async () => {
      const orderId = randomUUID();
      await project(orderCreated(orderId, { customer_id: ME }));

      const response = await timeline(bearer(ME), orderId).expect(200);

      expect(response.body).toMatchObject({
        order_id: orderId,
        customer_id: ME,
      });
    });

    it('answers a foreign order exactly like a missing one, from a cold cache', async () => {
      const orderId = randomUUID();
      await project(orderCreated(orderId, { customer_id: OTHER }));

      const foreign = await timeline(bearer(ME), orderId).expect(404);
      const missing = await timeline(bearer(ME), randomUUID()).expect(404);

      expect(foreign.body).toEqual({ message: 'order not found' });
      expect(foreign.body).toEqual(missing.body);
      expect(foreign.headers['content-type']).toBe(
        missing.headers['content-type'],
      );
    });

    it('answers a foreign order exactly like a missing one, from a warm cache', async () => {
      const orderId = randomUUID();
      await project(orderCreated(orderId, { customer_id: OTHER }));
      // The owner reads it first, so the entry is cached.
      await timeline(bearer(OTHER), orderId).expect(200);

      const foreign = await timeline(bearer(ME), orderId).expect(404);
      const missing = await timeline(bearer(ME), randomUUID()).expect(404);

      expect(foreign.body).toEqual(missing.body);
      await timeline(bearer(OTHER), orderId).expect(200);
    });

    it('never writes a cache key for a foreign order', async () => {
      const orderId = randomUUID();
      await project(orderCreated(orderId, { customer_id: OTHER }));

      await timeline(bearer(ME), orderId).expect(404);

      const redis = app.get(RedisConnection);
      expect(
        await redis.client.keys(`order-timeline:${orderId}:customer:*`),
      ).toEqual([]);
    });

    it.each([
      ['a NUL', '%00'],
      ['12,000 characters', 'a'.repeat(12_000)],
      ['a generation suffix', `${randomUUID()}:generation`],
    ])(
      'answers the 404 of a missing order to an id with %s',
      async (_n, id) => {
        const response = await timeline(bearer(ME), id).expect(404);

        expect(response.body).toEqual({ message: 'order not found' });
      },
    );

    it('answers 404 until order.created arrives, then serves the owner', async () => {
      const orderId = randomUUID();
      await project(stockReserved(orderId));

      await timeline(bearer(ME), orderId).expect(404);

      await project(orderCreated(orderId, { customer_id: ME }));
      await timeline(bearer(ME), orderId).expect(200);
    });
  });

  describe('the assistant sees only the orders of the customer asking', () => {
    it('finds no data for the order of another customer', async () => {
      const orderId = randomUUID();
      await project(orderCreated(orderId, { customer_id: OTHER }));
      const withFake = await createTestApp({ databaseUrl: database.url });
      try {
        const asOwner = await request(withFake.getHttpServer())
          .post('/v1/assistant/ask')
          .set('Authorization', bearer(OTHER))
          .set('X-Forwarded-For', randomIp())
          .send({ question: `¿Qué pasó con ${orderId}?` })
          .expect(200);
        const asStranger = await request(withFake.getHttpServer())
          .post('/v1/assistant/ask')
          .set('Authorization', bearer(ME))
          .set('X-Forwarded-For', randomIp())
          .send({ question: `¿Qué pasó con ${orderId}?` })
          .expect(200);

        expect(asOwner.body.citations).toEqual([
          { order_id: orderId, event_ids: expect.any(Array) },
        ]);
        expect(asStranger.body).toMatchObject({
          answer: `No encontré el pedido ${orderId}.`,
          outcome: 'no_data',
          citations: [],
        });
      } finally {
        await withFake.close();
      }
    });
  });
});

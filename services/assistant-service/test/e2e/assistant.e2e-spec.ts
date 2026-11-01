import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inject } from 'vitest';
import request from 'supertest';
import {
  LlmQuotaExceededError,
  LlmUnavailableError,
} from '../../src/features/assistant/application/contracts/llm-client.js';
import { ModelCallBudgetUnavailableError } from '../../src/features/assistant/application/contracts/model-call-budget.js';
import { toProjectionCommand } from '../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../src/features/order-history/application/usecases/project-order-event.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import {
  orderCreated,
  orderRejected,
  stockRejected,
  stockReserved,
} from '../support/order-events.js';
import { answer, ScriptedLlmClient } from '../support/scripted-llm-client.js';
import { StubModelCallBudget } from '../support/stub-model-call-budget.js';
import { createTestApp, randomIp } from '../support/test-app.js';

const REASON = 'insufficient stock for product SKU-005';

describe('assistant HTTP API', () => {
  let database: TestDatabase;
  let app: NestExpressApplication;

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    app = await createTestApp({
      databaseUrl: database.url,
      env: { ASK_RATE_LIMIT_PER_MINUTE: '2', TRUST_PROXY: 'loopback' },
    });
  });

  afterAll(async () => {
    await app?.close();
    await database.drop();
  });

  function ask(
    target: NestExpressApplication,
    body: object,
    ip = randomIp(),
  ): request.Test {
    return request(target.getHttpServer())
      .post('/v1/assistant/ask')
      .set('X-Forwarded-For', ip)
      .send(body);
  }

  async function rejectedOrder(): Promise<{
    orderId: string;
    eventIds: string[];
  }> {
    const orderId = randomUUID();
    const events = [
      orderCreated(orderId),
      stockRejected(orderId, REASON),
      orderRejected(orderId, REASON),
    ];
    const project = app.get(ProjectOrderEvent);
    for (const event of events)
      await project.execute(toProjectionCommand(event));
    return { orderId, eventIds: events.map((event) => event.event_id) };
  }

  describe('POST /v1/assistant/ask', () => {
    it('answers from the read model, citing the order and its events', async () => {
      const { orderId, eventIds } = await rejectedOrder();

      const response = await ask(app, {
        question: `¿Por qué se rechazó el pedido ${orderId}?`,
      }).expect(200);

      expect(response.body).toEqual({
        answer: `El pedido ${orderId} está rechazado (motivo: ${REASON}).`,
        outcome: 'answered',
        citations: [{ order_id: orderId, event_ids: eventIds }],
        tool_calls: [
          { name: 'get_order_timeline', args: { order_id: orderId } },
        ],
        model: 'fake',
      });
    });

    it('says it has no data for an unknown order', async () => {
      const orderId = randomUUID();

      const response = await ask(app, {
        question: `¿Qué pasó con ${orderId}?`,
      }).expect(200);

      expect(response.body).toMatchObject({
        answer: `No encontré el pedido ${orderId}.`,
        outcome: 'no_data',
        citations: [],
      });
    });

    it.each([
      ['no question', {}],
      ['an empty question', { question: '   ' }],
      ['a question over 500 characters', { question: 'a'.repeat(501) }],
      ['a question that is not text', { question: 42 }],
    ])('answers 400 to %s', async (_case, body) => {
      const response = await ask(app, body).expect(400);

      expect(response.body).toEqual({
        message: expect.stringContaining('question'),
      });
    });

    it('answers 429 past the limit per client IP, with Retry-After', async () => {
      const ip = randomIp();
      await ask(app, { question: 'hola' }, ip).expect(200);
      await ask(app, { question: 'hola' }, ip).expect(200);

      const refused = await ask(app, { question: 'hola' }, ip).expect(429);

      expect(refused.body).toEqual({
        message: 'too many questions, try again later',
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      await ask(app, { question: 'hola' }, randomIp()).expect(200);
    });

    it('counts the questions, tool calls and tokens in /metrics', async () => {
      const { orderId } = await rejectedOrder();
      await ask(app, { question: `¿Y ${orderId}?` }).expect(200);

      const metrics = await request(app.getHttpServer()).get('/metrics');

      expect(metrics.text).toMatch(
        /edo_assistant_questions_total\{outcome="answered"\} [1-9]/,
      );
      expect(metrics.text).toMatch(
        /edo_assistant_tool_calls_total\{tool="get_order_timeline"\} [1-9]/,
      );
      expect(metrics.text).toContain('# HELP edo_assistant_llm_tokens_total');
    });
  });

  describe('when a dependency fails', () => {
    it.each([
      [
        'the model quota is exhausted',
        new LlmQuotaExceededError('quota'),
        'the assistant ran out of model quota, try again later',
      ],
      [
        'the model is unavailable',
        new LlmUnavailableError('down'),
        'the assistant is unavailable, try again later',
      ],
    ])('answers 503 when %s', async (_case, error, message) => {
      const failing = await createTestApp({
        databaseUrl: database.url,
        llm: new ScriptedLlmClient([
          async () => {
            throw error;
          },
        ]),
      });
      try {
        const response = await ask(failing, { question: 'hola' }).expect(503);

        expect(response.body).toEqual({ message });
      } finally {
        await failing.close();
      }
    });

    it('answers 503 without calling the model once the daily budget of model calls is spent', async () => {
      // The budget is the real one in Redis, shared with the other tests of
      // the day, so only the second question is sure to find it spent.
      const llm = new ScriptedLlmClient([answer('hola'), answer('hola')]);
      const limited = await createTestApp({
        databaseUrl: database.url,
        env: { LLM_DAILY_CALL_LIMIT: '1', TRUST_PROXY: 'loopback' },
        llm,
      });
      try {
        await ask(limited, { question: 'hola' });
        const response = await ask(limited, { question: 'hola' }).expect(503);

        expect(response.body).toEqual({
          message: 'the assistant ran out of model quota, try again later',
        });
        expect(llm.requests.length).toBeLessThanOrEqual(1);
      } finally {
        await limited.close();
      }
    });

    it('answers 503 when the daily budget cannot be checked', async () => {
      const failing = await createTestApp({
        databaseUrl: database.url,
        env: { TRUST_PROXY: 'loopback' },
        budget: new StubModelCallBudget(
          Number.POSITIVE_INFINITY,
          new ModelCallBudgetUnavailableError('down'),
        ),
      });
      try {
        const response = await ask(failing, { question: 'hola' }).expect(503);

        expect(response.body).toEqual({
          message: 'the assistant is unavailable, try again later',
        });
      } finally {
        await failing.close();
      }
    });

    it('refuses questions when Redis is down (fails closed), but keeps serving timelines', async () => {
      const { orderId } = await rejectedOrder();
      const noRedis = await createTestApp({
        databaseUrl: database.url,
        env: { REDIS_URL: 'redis://127.0.0.1:1/0' },
      });
      try {
        const response = await ask(noRedis, { question: 'hola' }).expect(503);
        expect(response.body).toEqual({
          message: 'the assistant is unavailable, try again later',
        });

        await request(noRedis.getHttpServer())
          .get(`/v1/assistant/orders/${orderId}/timeline`)
          .expect(200);
        const health = await request(noRedis.getHttpServer())
          .get('/health')
          .expect(200);
        expect(health.body.redis).toBe('unhealthy');
      } finally {
        await noRedis.close();
      }
    });
  });

  describe('GET /v1/assistant/orders/:orderId/timeline', () => {
    it('shows a new event right away, though the timeline is cached', async () => {
      const orderId = randomUUID();
      const project = app.get(ProjectOrderEvent);
      await project.execute(toProjectionCommand(orderCreated(orderId)));
      const timeline = () =>
        request(app.getHttpServer())
          .get(`/v1/assistant/orders/${orderId}/timeline`)
          .expect(200);
      expect((await timeline()).body.events).toHaveLength(1);

      await project.execute(toProjectionCommand(stockReserved(orderId)));

      expect((await timeline()).body.events).toHaveLength(2);
    });
  });

  describe('GET /health', () => {
    it('reports Redis next to the database and the broker', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        service: 'assistant-service',
        database: 'healthy',
        broker: 'unhealthy',
        redis: 'healthy',
      });
    });
  });
});

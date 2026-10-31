import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { ENV, loadEnv } from '../../src/core/config/env.js';
import { RabbitMQConnection } from '../../src/core/messaging/rabbitmq.connection.js';
import { toProjectionCommand } from '../../src/features/order-history/application/mappers/order-event.mapper.js';
import { ProjectOrderEvent } from '../../src/features/order-history/application/usecases/project-order-event.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { FakeBroker } from '../support/fake-broker.js';
import {
  orderCreated,
  orderRejected,
  stockRejected,
} from '../support/order-events.js';

async function createApp(
  databaseUrl: string,
  broker: FakeBroker,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        DATABASE_URL: databaseUrl,
        RABBITMQ_URL: 'amqp://broker@localhost:5672/',
        LOG_LEVEL: 'silent',
      }),
    )
    .overrideProvider(RabbitMQConnection)
    .useValue(broker)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('assistant-service HTTP API', () => {
  let database: TestDatabase;
  let app: INestApplication;
  const broker = new FakeBroker(false);

  beforeAll(async () => {
    database = await createTestDatabase(inject('adminDatabaseUrl'));
    app = await createApp(database.url, broker);
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  describe('GET /health', () => {
    it('answers 200 with the database and the broker status', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({
        status: 'ok',
        service: 'assistant-service',
        database: 'healthy',
        broker: 'unhealthy',
      });
    });

    it('reports a connected broker as healthy', async () => {
      const connected = await createApp(database.url, new FakeBroker(true));
      try {
        const response = await request(connected.getHttpServer())
          .get('/health')
          .expect(200);
        expect(response.body.broker).toBe('healthy');
      } finally {
        await connected.close();
      }
    });

    it('still answers 200 when the database is down (ADR-0014)', async () => {
      const down = await createApp(
        'postgresql://nobody@127.0.0.1:1/none',
        new FakeBroker(true),
      );
      try {
        const response = await request(down.getHttpServer())
          .get('/health')
          .expect(200);
        expect(response.body).toMatchObject({
          database: 'unhealthy',
          broker: 'healthy',
        });
      } finally {
        await down.close();
      }
    });

    it('registers the order events consumer with the broker', () => {
      expect(broker.setups).toHaveLength(1);
    });
  });

  describe('GET /metrics', () => {
    it('serves the edo_* metrics in the Prometheus format', async () => {
      const response = await request(app.getHttpServer())
        .get('/metrics')
        .expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# HELP edo_events_processed_total');
      expect(response.text).toContain('# HELP edo_events_dlq_total');
    });
  });

  describe('GET /v1/assistant/orders/:orderId/timeline', () => {
    it('answers 404 like order-service when the order is unknown', async () => {
      const response = await request(app.getHttpServer())
        .get('/v1/assistant/orders/missing/timeline')
        .expect(404);

      expect(response.body).toEqual({ message: 'order not found' });
    });

    it('returns the order and its events, with the rejection reasons', async () => {
      const project = app.get(ProjectOrderEvent);
      const created = orderCreated('o-1');
      const rejectedStock = stockRejected(
        'o-1',
        'insufficient stock for product SKU-001',
      );
      const rejected = orderRejected(
        'o-1',
        'insufficient stock for product SKU-001',
      );
      for (const event of [created, rejectedStock, rejected]) {
        await project.execute(toProjectionCommand(event));
      }

      const response = await request(app.getHttpServer())
        .get('/v1/assistant/orders/o-1/timeline')
        .expect(200);

      expect(response.body).toEqual({
        order_id: 'o-1',
        customer_id: 'c-1',
        status: 'rejected',
        stock_result: 'rejected',
        rejection_reason: 'insufficient stock for product SKU-001',
        total_amount: '20.00',
        items: [{ product_id: 'SKU-001', quantity: 2, unit_price: '10.00' }],
        created_at: '2026-10-31T12:00:00.000Z',
        last_event_at: '2026-10-31T12:00:02.000Z',
        events: [
          {
            event_id: created.event_id,
            event_type: 'order.created',
            occurred_at: '2026-10-31T12:00:00.000Z',
            correlation_id: 'corr-o-1',
          },
          {
            event_id: rejectedStock.event_id,
            event_type: 'stock.rejected',
            occurred_at: '2026-10-31T12:00:01.000Z',
            correlation_id: 'corr-o-1',
            reason: 'insufficient stock for product SKU-001',
          },
          {
            event_id: rejected.event_id,
            event_type: 'order.rejected',
            occurred_at: '2026-10-31T12:00:02.000Z',
            correlation_id: 'corr-o-1',
            reason: 'insufficient stock for product SKU-001',
          },
        ],
      });
    });
  });

  describe('X-Correlation-ID', () => {
    it('echoes the header it receives', async () => {
      const response = await request(app.getHttpServer())
        .get('/health')
        .set('X-Correlation-ID', 'abc-123');

      expect(response.headers['x-correlation-id']).toBe('abc-123');
    });

    it('generates one when the request has none', async () => {
      const response = await request(app.getHttpServer()).get('/health');

      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

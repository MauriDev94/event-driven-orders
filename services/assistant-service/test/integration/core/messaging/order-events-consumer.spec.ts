import { randomBytes } from 'node:crypto';
import amqplib, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { DomainError } from '../../../../src/common/domain-error.js';
import type { Env } from '../../../../src/core/config/env.js';
import { RabbitMQConnection } from '../../../../src/core/messaging/rabbitmq.connection.js';
import {
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  ORDERS_EXCHANGE,
} from '../../../../src/core/messaging/topology.js';
import { consumeOrderEvents } from '../../../../src/features/order-history/presentation/consumers/order-events.consumer.js';
import { stockReserved } from '../../../support/order-events.js';

// The adapter against a real RabbitMQ: topology, prefetch, ack and the retry
// protocol on an amqplib channel opened by the recovering connection.
describe('order events consumer on RabbitMQ', () => {
  let container: StartedTestContainer;
  let connection: RabbitMQConnection;
  let publisher: ChannelModel;
  let outcome: () => Promise<void>;
  const received: ConsumeMessage[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    const user = 'test';
    const password = randomBytes(16).toString('hex');
    container = await new GenericContainer('rabbitmq:3.13-management')
      .withEnvironment({
        RABBITMQ_DEFAULT_USER: user,
        RABBITMQ_DEFAULT_PASS: password,
      })
      .withExposedPorts(5672)
      .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
      .withStartupTimeout(120_000)
      .start();
    const url = `amqp://${user}:${password}@${container.getHost()}:${container.getMappedPort(5672)}/`;

    connection = new RabbitMQConnection({ RABBITMQ_URL: url } as Env);
    connection.addSetup((channel) =>
      consumeOrderEvents(
        channel,
        async (message) => {
          received.push(message);
          await outcome();
        },
        logger,
      ),
    );
    await connection.start();
    await vi.waitFor(() => expect(connection.isConnected()).toBe(true), {
      timeout: 15_000,
    });
    publisher = await amqplib.connect(url);
  });

  afterAll(async () => {
    await publisher?.close();
    await connection?.close();
    await container?.stop();
  });

  beforeEach(() => {
    received.length = 0;
    outcome = async () => {};
  });

  async function publish(event: object, routingKey: string): Promise<void> {
    const channel = await publisher.createChannel();
    channel.publish(
      ORDERS_EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        contentType: 'application/json',
      },
    );
    await channel.close();
  }

  async function queueDepth(queue: string): Promise<number> {
    const channel = await publisher.createChannel();
    const { messageCount } = await channel.checkQueue(queue);
    await channel.close();
    return messageCount;
  }

  it('delivers an order event and acks it', async () => {
    await publish(stockReserved('o-1'), 'stock.reserved');

    await vi.waitFor(() => expect(received).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(JSON.parse(received[0]!.content.toString())).toMatchObject({
      order_id: 'o-1',
    });
    await vi.waitFor(async () =>
      expect(await queueDepth(ORDER_EVENTS_QUEUE)).toBe(0),
    );
  });

  it('dead-letters a permanent failure', async () => {
    outcome = async () => {
      throw new DomainError('impossible transition');
    };
    await publish(stockReserved('o-2'), 'stock.reserved');

    await vi.waitFor(
      async () => expect(await queueDepth(ORDER_EVENTS_DLQ)).toBe(1),
      { timeout: 10_000 },
    );
  });

  it('sends a transient failure to retry-5s with x-retry-count 1', async () => {
    outcome = async () => {
      throw new Error('database unavailable');
    };
    await publish(stockReserved('o-3'), 'stock.reserved');

    const channel = await publisher.createChannel();
    try {
      // Read it before its 5 s TTL sends it back to the main queue.
      const retried = await vi.waitFor(
        async () => {
          const message = await channel.get(`${ORDER_EVENTS_QUEUE}.retry-5s`);
          if (message === false) throw new Error('not in retry-5s yet');
          return message;
        },
        { timeout: 4_000, interval: 100 },
      );
      expect(retried.properties.headers?.['x-retry-count']).toBe(1);
      expect(JSON.parse(retried.content.toString())).toMatchObject({
        order_id: 'o-3',
      });
      channel.ack(retried);
    } finally {
      await channel.close();
    }
  });

  it('ignores event types it is not bound to', async () => {
    await publish(
      { ...stockReserved('o-4'), event_type: 'stock.released' },
      'stock.released',
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(received).toHaveLength(0);
  });
});

import {
  declareTopology,
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  ORDERS_EXCHANGE,
} from '../../../../src/core/messaging/topology.js';

function fakeChannel() {
  return {
    assertExchange: vi.fn(async () => ({ exchange: ORDERS_EXCHANGE })),
    assertQueue: vi.fn(async (queue: string) => ({
      queue,
      messageCount: 0,
      consumerCount: 0,
    })),
    bindQueue: vi.fn(async () => ({})),
  };
}

describe('declareTopology', () => {
  it('declares the durable orders topic exchange shared with the other services', async () => {
    const channel = fakeChannel();
    await declareTopology(channel);

    expect(channel.assertExchange).toHaveBeenCalledWith('orders', 'topic', {
      durable: true,
    });
  });

  it('dead-letters the main queue to its DLQ through the default exchange', async () => {
    const channel = fakeChannel();
    await declareTopology(channel);

    expect(ORDER_EVENTS_QUEUE).toBe('assistant-service.order-events');
    expect(channel.assertQueue).toHaveBeenCalledWith(ORDER_EVENTS_DLQ, {
      durable: true,
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(ORDER_EVENTS_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': 'assistant-service.order-events.dlq',
      },
    });
  });

  it.each([
    ['retry-5s', 5_000],
    ['retry-30s', 30_000],
    ['retry-2m', 120_000],
  ])(
    'declares %s, which returns messages to the main queue after its TTL',
    async (suffix, ttl) => {
      const channel = fakeChannel();
      await declareTopology(channel);

      expect(channel.assertQueue).toHaveBeenCalledWith(
        `${ORDER_EVENTS_QUEUE}.${suffix}`,
        {
          durable: true,
          arguments: {
            'x-message-ttl': ttl,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': ORDER_EVENTS_QUEUE,
          },
        },
      );
    },
  );

  it('binds the main queue to the five order events by name, without a wildcard', async () => {
    const channel = fakeChannel();
    await declareTopology(channel);

    const keys = channel.bindQueue.mock.calls.map((call) => {
      const [queue, exchange, key] = call as unknown as [
        string,
        string,
        string,
      ];
      expect([queue, exchange]).toEqual([ORDER_EVENTS_QUEUE, ORDERS_EXCHANGE]);
      return key;
    });
    expect(keys.sort()).toEqual([
      'order.confirmed',
      'order.created',
      'order.rejected',
      'stock.rejected',
      'stock.reserved',
    ]);
  });
});

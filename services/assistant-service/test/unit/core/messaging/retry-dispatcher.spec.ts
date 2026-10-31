import { randomUUID } from 'node:crypto';
import type { ConsumeMessage } from 'amqplib';
import type { Counter } from 'prom-client';
import { DomainError } from '../../../../src/common/domain-error.js';
import { wrapWithRetry } from '../../../../src/core/messaging/retry-dispatcher.js';
import {
  EVENTS_DLQ,
  EVENTS_RETRIED,
} from '../../../../src/core/observability/metrics.js';

function fakeChannel() {
  return { ack: vi.fn(), nack: vi.fn(), sendToQueue: vi.fn(() => true) };
}

function fakeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

function message(headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from(
      JSON.stringify({ event_type: 'order.created', correlation_id: 'corr-1' }),
    ),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: 'orders',
      routingKey: 'order.created',
      consumerTag: 'ctag',
    },
    properties: {
      headers,
      contentType: 'application/json',
      contentEncoding: undefined,
      deliveryMode: 2,
      priority: undefined,
      correlationId: 'corr-1',
      replyTo: undefined,
      expiration: undefined,
      messageId: 'event-1',
      timestamp: undefined,
      type: 'order.created',
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  } as ConsumeMessage;
}

async function counterValue(counter: Counter, queue: string): Promise<number> {
  const metric = await counter.get();
  return metric.values.find((v) => v.labels['queue'] === queue)?.value ?? 0;
}

describe('wrapWithRetry', () => {
  // A queue name per test keeps the shared counters independent.
  let queue: string;
  let channel: ReturnType<typeof fakeChannel>;
  let logger: ReturnType<typeof fakeLogger>;

  beforeEach(() => {
    queue = `test-${randomUUID()}`;
    channel = fakeChannel();
    logger = fakeLogger();
  });

  function dispatch(handler: () => Promise<void>) {
    return wrapWithRetry(handler, { channel, mainQueue: queue, logger });
  }

  it('acks the message when the handler succeeds', async () => {
    const msg = message();
    await dispatch(async () => {})(msg);

    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('republishes a transient failure to the first retry queue and acks the original', async () => {
    const msg = message({ 'x-other': 'kept' });
    await dispatch(async () => {
      throw new Error('database unavailable');
    })(msg);

    expect(channel.sendToQueue).toHaveBeenCalledExactlyOnceWith(
      `${queue}.retry-5s`,
      msg.content,
      {
        headers: { 'x-other': 'kept', 'x-retry-count': 1 },
        persistent: true,
        contentType: 'application/json',
        messageId: 'event-1',
        correlationId: 'corr-1',
        type: 'order.created',
      },
    );
    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(await counterValue(EVENTS_RETRIED, queue)).toBe(1);
  });

  it('moves to the next stage according to x-retry-count', async () => {
    await dispatch(async () => {
      throw new Error('timeout');
    })(message({ 'x-retry-count': 2 }));

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      `${queue}.retry-2m`,
      expect.any(Buffer),
      expect.objectContaining({ headers: { 'x-retry-count': 3 } }),
    );
  });

  it('reads an x-retry-count republished by hand as a string', async () => {
    await dispatch(async () => {
      throw new Error('timeout');
    })(message({ 'x-retry-count': '1' }));

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      `${queue}.retry-30s`,
      expect.any(Buffer),
      expect.objectContaining({ headers: { 'x-retry-count': 2 } }),
    );
  });

  it('dead-letters a transient failure after the last retry', async () => {
    const msg = message({ 'x-retry-count': 3 });
    await dispatch(async () => {
      throw new Error('still failing');
    })(msg);

    expect(channel.nack).toHaveBeenCalledExactlyOnceWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(await counterValue(EVENTS_DLQ, queue)).toBe(1);
  });

  it('dead-letters a permanent failure without retrying', async () => {
    const msg = message();
    await dispatch(async () => {
      throw new DomainError('confirmed order cannot be rejected');
    })(msg);

    expect(channel.nack).toHaveBeenCalledExactlyOnceWith(msg, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queue,
        retry_count: 0,
        correlation_id: 'corr-1',
      }),
      expect.stringContaining('dead-letter'),
    );
  });

  it('ignores the null delivery the broker sends when it cancels the consumer', async () => {
    const handler = vi.fn(async () => {});
    await wrapWithRetry(handler, { channel, mainQueue: queue, logger })(null);

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('never rejects, even if the channel fails while acking', async () => {
    channel.ack.mockImplementation(() => {
      throw new Error('Channel closed');
    });

    await expect(dispatch(async () => {})(message())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

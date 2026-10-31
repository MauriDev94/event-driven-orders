import type { ConsumeMessage } from 'amqplib';
import { ZodError } from 'zod';
import { InvalidMessageError } from '../../../../../src/core/messaging/retry-policy.js';
import { EVENTS_PROCESSED } from '../../../../../src/core/observability/metrics.js';
import type { ProjectOrderEvent } from '../../../../../src/features/order-history/application/usecases/project-order-event.js';
import { buildOrderEventHandler } from '../../../../../src/features/order-history/presentation/consumers/order-events.handler.js';
import { stockReserved } from '../../../../support/order-events.js';

function message(body: string): ConsumeMessage {
  return {
    content: Buffer.from(body),
    fields: {},
    properties: { headers: {} },
  } as unknown as ConsumeMessage;
}

async function processed(eventType: string): Promise<number> {
  const metric = await EVENTS_PROCESSED.get();
  return (
    metric.values.find(
      (v) =>
        v.labels['service'] === 'assistant-service' &&
        v.labels['event_type'] === eventType,
    )?.value ?? 0
  );
}

describe('buildOrderEventHandler', () => {
  const logger = { info: vi.fn() };
  let execute: ReturnType<typeof vi.fn>;
  let handle: (message: ConsumeMessage) => Promise<void>;

  beforeEach(() => {
    execute = vi.fn(async () => 'projected');
    handle = buildOrderEventHandler(
      { execute } as unknown as ProjectOrderEvent,
      logger,
    );
  });

  it('validates the event, projects it and counts it', async () => {
    const event = stockReserved('o-1');
    const before = await processed('stock.reserved');

    await handle(message(JSON.stringify(event)));

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'stock.reserved',
          orderId: 'o-1',
        }),
      }),
    );
    expect(await processed('stock.reserved')).toBe(before + 1);
  });

  it('rejects a body that is not JSON as an invalid message', async () => {
    await expect(handle(message('{not json'))).rejects.toThrow(
      InvalidMessageError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an event that fails the contract', async () => {
    const { order_id: _orderId, ...event } = stockReserved('o-1');

    await expect(handle(message(JSON.stringify(event)))).rejects.toThrow(
      ZodError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a use case failure through, for the retry dispatcher to classify', async () => {
    execute.mockRejectedValue(new Error('database unavailable'));

    await expect(
      handle(message(JSON.stringify(stockReserved('o-1')))),
    ).rejects.toThrow('database unavailable');
  });
});

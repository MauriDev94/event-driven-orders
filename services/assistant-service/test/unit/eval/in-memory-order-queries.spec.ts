import { randomUUID } from 'node:crypto';
import type { OrderDetails } from '../../../src/features/assistant/application/contracts/order-queries.js';
import { InMemoryOrderQueries } from '../../../eval/in-memory-order-queries.js';

function order(
  overrides: Partial<OrderDetails> & Pick<OrderDetails, 'status'>,
): OrderDetails {
  return {
    orderId: randomUUID(),
    customerId: 'c-1',
    stockResult: overrides.status === 'rejected' ? 'rejected' : 'reserved',
    rejectionReason: null,
    totalAmount: '10.00',
    createdAt: new Date('2026-11-04T10:00:00.000Z'),
    lastEventAt: new Date('2026-11-04T10:00:02.000Z'),
    items: [{ productId: 'SKU-001', quantity: 1, unitPrice: '10.00' }],
    events: [],
    ...overrides,
  };
}

describe('InMemoryOrderQueries', () => {
  const old = order({
    status: 'rejected',
    rejectionReason: 'insufficient stock for product SKU-005',
    items: [{ productId: 'SKU-005', quantity: 9, unitPrice: '10.00' }],
    createdAt: new Date('2026-11-02T10:00:00.000Z'),
    lastEventAt: new Date('2026-11-02T10:00:02.000Z'),
  });
  const rejected = order({
    status: 'rejected',
    rejectionReason: 'insufficient stock for product SKU-005',
    items: [{ productId: 'SKU-005', quantity: 99, unitPrice: '10.00' }],
    lastEventAt: new Date('2026-11-04T11:00:00.000Z'),
  });
  const confirmed = order({
    status: 'confirmed',
    lastEventAt: new Date('2026-11-04T12:00:00.000Z'),
  });
  const queries = new InMemoryOrderQueries([old, rejected, confirmed]);
  const today = {
    from: new Date('2026-11-04T00:00:00.000Z'),
    until: new Date('2026-11-05T00:00:00.000Z'),
  };

  it('returns the timeline of a known order, and null for an unknown one', async () => {
    await expect(queries.timeline(rejected.orderId)).resolves.toEqual(rejected);
    await expect(queries.timeline(randomUUID())).resolves.toBeNull();
  });

  it('searches by status, product and creation range, most recent activity first', async () => {
    const byStatus = await queries.search({ status: 'rejected', limit: 10 });
    const byProduct = await queries.search({ productId: 'SKU-001', limit: 10 });
    const inRange = await queries.search({ ...today, limit: 10 });

    expect(byStatus.map((found) => found.orderId)).toEqual([
      rejected.orderId,
      old.orderId,
    ]);
    expect(byProduct.map((found) => found.orderId)).toEqual([
      confirmed.orderId,
    ]);
    expect(inRange.map((found) => found.orderId)).toEqual([
      confirmed.orderId,
      rejected.orderId,
    ]);
  });

  it('returns summaries without items or events, up to the limit', async () => {
    const [first, ...rest] = await queries.search({ limit: 1 });

    expect(rest).toEqual([]);
    expect(first).not.toHaveProperty('items');
    expect(first).not.toHaveProperty('events');
  });

  it('groups the rejected orders of a range by reason', async () => {
    await expect(queries.rejectionSummary(today)).resolves.toEqual({
      totalRejected: 1,
      groups: [
        {
          reason: 'insufficient stock for product SKU-005',
          count: 1,
          productIds: ['SKU-005'],
          orderIds: [rejected.orderId],
        },
      ],
    });
    await expect(queries.rejectionSummary({})).resolves.toMatchObject({
      totalRejected: 2,
      groups: [{ count: 2 }],
    });
  });
});

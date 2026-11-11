import { randomUUID } from 'node:crypto';
import type { OrderDetails } from '../../../src/features/assistant/application/contracts/order-queries.js';
import { InMemoryOrderQueries } from '../../../eval/in-memory-order-queries.js';

const ME = 'c-1';
const LIMITS = { groups: 10, productIdsPerGroup: 20 };

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
    await expect(queries.timeline(rejected.orderId, ME)).resolves.toEqual(
      rejected,
    );
    await expect(queries.timeline(randomUUID(), ME)).resolves.toBeNull();
  });

  it('searches by status, product and creation range, most recent activity first', async () => {
    const byStatus = await queries.search({
      customerId: ME,
      status: 'rejected',
      limit: 10,
    });
    const byProduct = await queries.search({
      customerId: ME,
      productId: 'SKU-001',
      limit: 10,
    });
    const inRange = await queries.search({
      customerId: ME,
      ...today,
      limit: 10,
    });

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
    const [first, ...rest] = await queries.search({ customerId: ME, limit: 1 });

    expect(rest).toEqual([]);
    expect(first).not.toHaveProperty('items');
    expect(first).not.toHaveProperty('events');
  });

  it('groups the rejected orders of a range by reason', async () => {
    await expect(
      queries.rejectionSummary({ customerId: ME, ...today }, LIMITS),
    ).resolves.toEqual({
      totalRejected: 1,
      totalGroups: 1,
      groups: [
        {
          reason: 'insufficient stock for product SKU-005',
          count: 1,
          productIds: ['SKU-005'],
          productTotal: 1,
          orderIds: [rejected.orderId],
        },
      ],
    });
    await expect(
      queries.rejectionSummary({ customerId: ME }, LIMITS),
    ).resolves.toMatchObject({
      totalRejected: 2,
      totalGroups: 1,
      groups: [{ count: 2 }],
    });
  });

  it('applies the group and product caps like the real query', async () => {
    const reasons = ['a', 'b', 'c'].map((letter, i) =>
      order({
        status: 'rejected',
        rejectionReason: `reason ${letter}`,
        items: [
          { productId: 'SKU-001', quantity: 1, unitPrice: '1.00' },
          { productId: 'SKU-002', quantity: 1, unitPrice: '1.00' },
          { productId: 'SKU-003', quantity: 1, unitPrice: '1.00' },
        ],
        lastEventAt: new Date(`2026-11-04T1${i}:00:00.000Z`),
      }),
    );
    const capped = new InMemoryOrderQueries(reasons);

    const summary = await capped.rejectionSummary(
      { customerId: ME },
      { groups: 2, productIdsPerGroup: 2 },
    );

    expect(summary.totalRejected).toBe(3);
    expect(summary.totalGroups).toBe(3);
    expect(summary.groups.map((group) => group.reason)).toEqual([
      'reason a',
      'reason b',
    ]);
    expect(summary.groups[0]).toMatchObject({
      productIds: ['SKU-001', 'SKU-002'],
      productTotal: 3,
    });
  });

  describe('other customers', () => {
    const theirs = order({
      status: 'rejected',
      customerId: 'c-2',
      rejectionReason: 'insufficient stock for product SKU-005',
      lastEventAt: new Date('2026-11-04T13:00:00.000Z'),
    });
    const mixed = new InMemoryOrderQueries([old, rejected, confirmed, theirs]);

    it('never returns the timeline of another customer', async () => {
      await expect(mixed.timeline(theirs.orderId, ME)).resolves.toBeNull();
      await expect(mixed.timeline(theirs.orderId, 'c-2')).resolves.toEqual(
        theirs,
      );
    });

    it('leaves them out of the searches', async () => {
      const found = await mixed.search({ customerId: ME, limit: 10 });

      expect(found.map((order) => order.orderId)).not.toContain(theirs.orderId);
      expect(found).toHaveLength(3);
    });

    it('leaves them out of the rejection groups and counts', async () => {
      const summary = await mixed.rejectionSummary({ customerId: ME }, LIMITS);

      expect(summary.totalRejected).toBe(2);
      expect(summary.groups[0]?.orderIds).not.toContain(theirs.orderId);
    });
  });
});

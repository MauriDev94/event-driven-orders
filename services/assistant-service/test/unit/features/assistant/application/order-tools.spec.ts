import { randomUUID } from 'node:crypto';
import {
  type AssistantTool,
  buildOrderTools,
  MAX_PRODUCT_IDS_PER_GROUP,
  MAX_REJECTION_GROUPS,
  MAX_TIMELINE_ITEMS,
} from '../../../../../src/features/assistant/application/tools/order-tools.js';
import {
  orderSummary,
  StubOrderQueries,
} from '../../../../support/stub-order-queries.js';

describe('order tools', () => {
  let queries: StubOrderQueries;
  let tools: Map<string, AssistantTool>;

  beforeEach(() => {
    queries = new StubOrderQueries();
    tools = new Map(
      buildOrderTools(queries).map((tool) => [tool.spec.name, tool]),
    );
  });

  function tool(name: string): AssistantTool {
    const found = tools.get(name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  }

  it('declares the three read-only tools with a JSON Schema each', () => {
    expect([...tools.keys()]).toEqual([
      'get_order_timeline',
      'search_orders',
      'rejection_summary',
    ]);
    for (const { spec } of tools.values()) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.parameters).toMatchObject({ type: 'object' });
      expect(spec.parameters).not.toHaveProperty('$schema');
    }
    expect(tool('get_order_timeline').spec.parameters).toMatchObject({
      required: ['order_id'],
    });
    expect(tool('search_orders').spec.parameters).toMatchObject({
      properties: { limit: { maximum: 20 } },
    });
  });

  describe('get_order_timeline', () => {
    it('returns the order and its events, and records them as evidence', async () => {
      const orderId = randomUUID();
      const [created, rejected] = [randomUUID(), randomUUID()];
      queries.details.set(orderId, {
        ...orderSummary(orderId),
        items: [{ productId: 'SKU-005', quantity: 999, unitPrice: '10.00' }],
        events: [
          {
            eventId: created,
            eventType: 'order.created',
            occurredAt: new Date('2026-10-31T12:00:00.000Z'),
            reason: null,
          },
          {
            eventId: rejected,
            eventType: 'stock.rejected',
            occurredAt: new Date('2026-10-31T12:00:01.000Z'),
            reason: 'insufficient stock for product SKU-005',
          },
        ],
      });

      const run = await tool('get_order_timeline').run({ order_id: orderId });

      expect(run.output).toEqual({
        found: true,
        order: {
          order_id: orderId,
          status: 'rejected',
          stock_result: 'rejected',
          rejection_reason: 'insufficient stock for product SKU-005',
          total_amount: '20.00',
          created_at: '2026-10-31T12:00:00.000Z',
          last_event_at: '2026-10-31T12:00:02.000Z',
          items: [
            { product_id: 'SKU-005', quantity: 999, unit_price: '10.00' },
          ],
          events: [
            {
              event_id: created,
              event_type: 'order.created',
              occurred_at: '2026-10-31T12:00:00.000Z',
            },
            {
              event_id: rejected,
              event_type: 'stock.rejected',
              occurred_at: '2026-10-31T12:00:01.000Z',
              reason: 'insufficient stock for product SKU-005',
            },
          ],
        },
      });
      expect(run.evidence).toEqual([
        { orderId, eventIds: [created, rejected] },
      ]);
    });

    it('sends at most the item cap and says how many there are', async () => {
      const orderId = randomUUID();
      const total = MAX_TIMELINE_ITEMS + 25;
      queries.details.set(orderId, {
        ...orderSummary(orderId),
        items: Array.from({ length: total }, (_, i) => ({
          productId: `SKU-${i}`,
          quantity: 1,
          unitPrice: '1.00',
        })),
        events: [],
      });

      const { output } = await tool('get_order_timeline').run({
        order_id: orderId,
      });

      const order = (output as { order: Record<string, unknown> }).order;
      expect(order['items']).toHaveLength(MAX_TIMELINE_ITEMS);
      expect(order['items']).toEqual(
        Array.from({ length: MAX_TIMELINE_ITEMS }, (_, i) => ({
          product_id: `SKU-${i}`,
          quantity: 1,
          unit_price: '1.00',
        })),
      );
      expect(order).toMatchObject({
        items_truncated: true,
        items_total: total,
      });
    });

    it('does not mention truncation when every item fits', async () => {
      const orderId = randomUUID();
      queries.details.set(orderId, {
        ...orderSummary(orderId),
        items: Array.from({ length: MAX_TIMELINE_ITEMS }, (_, i) => ({
          productId: `SKU-${i}`,
          quantity: 1,
          unitPrice: '1.00',
        })),
        events: [],
      });

      const { output } = await tool('get_order_timeline').run({
        order_id: orderId,
      });

      const order = (output as { order: Record<string, unknown> }).order;
      expect(order['items']).toHaveLength(MAX_TIMELINE_ITEMS);
      expect(order).not.toHaveProperty('items_truncated');
      expect(order).not.toHaveProperty('items_total');
    });

    it('never sends the customer id', async () => {
      const orderId = randomUUID();
      queries.details.set(orderId, {
        ...orderSummary(orderId, { customerId: 'visitor-chosen-id' }),
        items: null,
        events: [],
      });
      queries.orders = [
        orderSummary(randomUUID(), { customerId: 'visitor-chosen-id' }),
      ];

      const timeline = await tool('get_order_timeline').run({
        order_id: orderId,
      });
      const search = await tool('search_orders').run({});

      expect(JSON.stringify(timeline.output)).not.toContain('visitor-chosen');
      expect(JSON.stringify(search.output)).not.toContain('visitor-chosen');
    });

    it('says so when the order is unknown, with no evidence', async () => {
      const orderId = randomUUID();

      const run = await tool('get_order_timeline').run({ order_id: orderId });

      expect(run).toEqual({
        output: { found: false, order_id: orderId },
        evidence: [],
      });
    });

    it('answers invalid arguments with an error for the model', async () => {
      const run = await tool('get_order_timeline').run({ id: 'x' });

      expect(run.evidence).toEqual([]);
      expect(run.output).toEqual({
        error: expect.stringContaining('order_id'),
      });
    });
  });

  describe('search_orders', () => {
    it('passes the filters and returns the orders as evidence', async () => {
      const [first, second] = [randomUUID(), randomUUID()];
      queries.orders = [
        orderSummary(first),
        orderSummary(second, {
          status: 'confirmed',
          stockResult: 'reserved',
          rejectionReason: null,
          createdAt: null,
        }),
      ];

      const run = await tool('search_orders').run({
        status: 'rejected',
        from: '2026-10-31',
        to: '2026-10-31',
        product_id: 'SKU-005',
        limit: 5,
      });

      expect(queries.searches).toEqual([
        {
          status: 'rejected',
          from: new Date('2026-10-31T00:00:00.000Z'),
          // A date-only `to` includes that whole day.
          until: new Date('2026-11-01T00:00:00.000Z'),
          productId: 'SKU-005',
          limit: 5,
        },
      ]);
      expect(run.output).toEqual({
        count: 2,
        orders: [
          {
            order_id: first,
            status: 'rejected',
            stock_result: 'rejected',
            rejection_reason: 'insufficient stock for product SKU-005',
            total_amount: '20.00',
            created_at: '2026-10-31T12:00:00.000Z',
            last_event_at: '2026-10-31T12:00:02.000Z',
          },
          {
            order_id: second,
            status: 'confirmed',
            stock_result: 'reserved',
            rejection_reason: null,
            total_amount: '20.00',
            created_at: null,
            last_event_at: '2026-10-31T12:00:02.000Z',
          },
        ],
      });
      expect(run.evidence).toEqual([
        { orderId: first, eventIds: [] },
        { orderId: second, eventIds: [] },
      ]);
    });

    it('defaults to 10 orders and takes date-times as given', async () => {
      await tool('search_orders').run({
        from: '2026-10-31T10:00:00Z',
        to: '2026-10-31T11:00:00-03:00',
      });

      expect(queries.searches).toEqual([
        {
          from: new Date('2026-10-31T10:00:00.000Z'),
          // An explicit date-time `to` is inclusive.
          until: new Date('2026-10-31T14:00:00.001Z'),
          limit: 10,
        },
      ]);
    });

    it('refuses more than 20 orders', async () => {
      const run = await tool('search_orders').run({ limit: 50 });

      expect(run.output).toEqual({ error: expect.stringContaining('limit') });
      expect(queries.searches).toEqual([]);
    });

    it('refuses a date it cannot read', async () => {
      const run = await tool('search_orders').run({ from: 'yesterday' });

      expect(run.output).toEqual({ error: expect.stringContaining('from') });
      expect(queries.searches).toEqual([]);
    });
  });

  describe('rejection_summary', () => {
    it('groups the rejections and cites every order in them', async () => {
      const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
      queries.rejections = {
        totalRejected: 3,
        totalGroups: 2,
        groups: [
          {
            reason: 'insufficient stock for product SKU-005',
            count: 2,
            productIds: ['SKU-005'],
            productTotal: 1,
            orderIds: [first, second],
          },
          {
            reason: 'insufficient stock for product SKU-004',
            count: 1,
            productIds: ['SKU-001', 'SKU-004'],
            productTotal: 2,
            orderIds: [third],
          },
        ],
      };

      const run = await tool('rejection_summary').run({ from: '2026-10-31' });

      expect(queries.rejectionRanges).toEqual([
        { from: new Date('2026-10-31T00:00:00.000Z') },
      ]);
      expect(run.output).toEqual({
        total_rejected: 3,
        groups: [
          {
            reason: 'insufficient stock for product SKU-005',
            count: 2,
            product_ids: ['SKU-005'],
            order_ids: [first, second],
          },
          {
            reason: 'insufficient stock for product SKU-004',
            count: 1,
            product_ids: ['SKU-001', 'SKU-004'],
            order_ids: [third],
          },
        ],
      });
      expect(run.evidence).toEqual([
        { orderId: first, eventIds: [] },
        { orderId: second, eventIds: [] },
        { orderId: third, eventIds: [] },
      ]);
    });

    it('asks the query for at most the group and product caps', async () => {
      await tool('rejection_summary').run({});

      expect(queries.rejectionLimits).toEqual([
        {
          groups: MAX_REJECTION_GROUPS,
          productIdsPerGroup: MAX_PRODUCT_IDS_PER_GROUP,
        },
      ]);
    });

    it('says when groups were cut, with the exact totals', async () => {
      const groups = Array.from({ length: MAX_REJECTION_GROUPS }, (_, i) => ({
        reason: `insufficient stock for product SKU-${i}`,
        count: 3,
        productIds: [`SKU-${i}`],
        productTotal: 1,
        orderIds: [randomUUID()],
      }));
      queries.rejections = {
        totalRejected: 500,
        totalGroups: MAX_REJECTION_GROUPS + 40,
        groups,
      };

      const { output } = await tool('rejection_summary').run({});

      expect(output).toMatchObject({
        total_rejected: 500,
        truncated: true,
        groups_total: MAX_REJECTION_GROUPS + 40,
      });
      expect((output['groups'] as unknown[]).length).toBe(MAX_REJECTION_GROUPS);
    });

    it('says when the products of a group were cut', async () => {
      const productIds = Array.from(
        { length: MAX_PRODUCT_IDS_PER_GROUP },
        (_, i) => `SKU-${i}`,
      );
      queries.rejections = {
        totalRejected: 2,
        totalGroups: 1,
        groups: [
          {
            reason: 'insufficient stock for product SKU-1',
            count: 2,
            productIds,
            productTotal: MAX_PRODUCT_IDS_PER_GROUP + 30,
            orderIds: [randomUUID()],
          },
        ],
      };

      const { output } = await tool('rejection_summary').run({});

      expect(output).not.toHaveProperty('truncated');
      expect(output['groups']).toEqual([
        expect.objectContaining({
          product_ids: productIds,
          product_ids_truncated: true,
          product_ids_total: MAX_PRODUCT_IDS_PER_GROUP + 30,
        }),
      ]);
    });
  });
});

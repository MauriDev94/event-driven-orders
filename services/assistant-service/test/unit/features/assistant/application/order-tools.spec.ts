import { randomUUID } from 'node:crypto';
import {
  type AssistantTool,
  buildOrderTools,
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
          customer_id: 'c-1',
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
            customer_id: 'c-1',
            status: 'rejected',
            stock_result: 'rejected',
            rejection_reason: 'insufficient stock for product SKU-005',
            total_amount: '20.00',
            created_at: '2026-10-31T12:00:00.000Z',
            last_event_at: '2026-10-31T12:00:02.000Z',
          },
          {
            order_id: second,
            customer_id: 'c-1',
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
        groups: [
          {
            reason: 'insufficient stock for product SKU-005',
            count: 2,
            productIds: ['SKU-005'],
            orderIds: [first, second],
          },
          {
            reason: 'insufficient stock for product SKU-004',
            count: 1,
            productIds: ['SKU-001', 'SKU-004'],
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
  });
});

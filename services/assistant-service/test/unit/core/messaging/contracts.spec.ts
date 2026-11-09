import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { orderEventSchema } from '../../../../src/core/messaging/contracts.js';

// Written by scripts/export_contract_fixtures.py from the Pydantic models in
// shared/contracts; CI fails if they are stale.
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'contracts',
);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

describe('orderEventSchema', () => {
  const names = readdirSync(FIXTURES).map((file) =>
    file.replace(/\.json$/, ''),
  );

  it('has a fixture for each of the five events', () => {
    expect(names.sort()).toEqual([
      'order.confirmed',
      'order.created',
      'order.rejected',
      'stock.rejected',
      'stock.reserved',
    ]);
  });

  it.each(names)('parses the %s event Pydantic serializes', (name) => {
    expect(orderEventSchema.parse(fixture(name))).toMatchObject({
      event_type: name,
      order_id: '6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a7b',
    });
  });

  it('keeps Decimal amounts as strings', () => {
    const event = orderEventSchema.parse(fixture('order.created'));

    expect(event).toMatchObject({
      total_amount: '25.50',
      items: [
        { product_id: 'SKU-001', quantity: 2, unit_price: '10.00' },
        { product_id: 'SKU-002', quantity: 1, unit_price: '5.50' },
      ],
    });
  });

  it('rejects an unknown event_type', () => {
    expect(() =>
      orderEventSchema.parse({
        ...fixture('stock.reserved'),
        event_type: 'stock.released',
      }),
    ).toThrow(ZodError);
  });

  it('rejects an event without order_id', () => {
    const { order_id: _orderId, ...event } = fixture('order.confirmed');
    expect(() => orderEventSchema.parse(event)).toThrow(ZodError);
  });

  it('rejects an item with a quantity of zero, like Field(gt=0)', () => {
    const event = fixture('order.created');
    const items = [{ product_id: 'SKU-001', quantity: 0, unit_price: '10.00' }];
    expect(() => orderEventSchema.parse({ ...event, items })).toThrow(ZodError);
  });

  it('rejects an amount that is not a decimal string', () => {
    expect(() =>
      orderEventSchema.parse({
        ...fixture('order.created'),
        total_amount: 25.5,
      }),
    ).toThrow(ZodError);
  });

  // Bounds that mirror order-service's request validation, so a visitor's
  // text can't grow the read model, and anything outside them is a ZodError
  // (a permanent failure: the message goes to the DLQ).
  describe('bounds', () => {
    const created = () => fixture('order.created');
    const item = { product_id: 'SKU-001', quantity: 1, unit_price: '1.00' };

    it.each([
      ['event_id', 'order.created'],
      ['order_id', 'order.created'],
      ['customer_id', 'order.created'],
      ['order_id', 'stock.reserved'],
      ['customer_id', 'order.confirmed'],
    ])('accepts a %s of 36 characters in %s', (field, name) => {
      const id = 'a'.repeat(36);
      expect(() =>
        orderEventSchema.parse({ ...fixture(name), [field]: id }),
      ).not.toThrow();
    });

    it.each([
      ['event_id', 'order.created'],
      ['order_id', 'order.created'],
      ['customer_id', 'order.created'],
      ['order_id', 'stock.reserved'],
      ['customer_id', 'order.confirmed'],
      ['customer_id', 'order.rejected'],
    ])('rejects a %s of 37 characters in %s', (field, name) => {
      expect(() =>
        orderEventSchema.parse({ ...fixture(name), [field]: 'a'.repeat(37) }),
      ).toThrow(ZodError);
    });

    it.each(['has space', '-starts-with-dash', '.dot', 'ñandú', 'a/b', 'x\ny'])(
      'rejects the id %j, like order-service',
      (id) => {
        expect(() =>
          orderEventSchema.parse({ ...created(), customer_id: id }),
        ).toThrow(ZodError);
        expect(() =>
          orderEventSchema.parse({
            ...created(),
            items: [{ ...item, product_id: id }],
          }),
        ).toThrow(ZodError);
      },
    );

    it('accepts the ids order-service accepts', () => {
      expect(() =>
        orderEventSchema.parse({
          ...created(),
          customer_id: 'c1.A_b-9',
          items: [{ ...item, product_id: 'SKU-001' }],
        }),
      ).not.toThrow();
    });

    it('bounds the product id of an item to 36 characters', () => {
      const items = [{ ...item, product_id: 'p'.repeat(37) }];
      expect(() => orderEventSchema.parse({ ...created(), items })).toThrow(
        ZodError,
      );
    });

    it.each(['stock.rejected', 'order.rejected'])(
      'bounds the reason of %s to 200 characters',
      (name) => {
        const event = fixture(name);
        expect(() =>
          orderEventSchema.parse({ ...event, reason: 'r'.repeat(200) }),
        ).not.toThrow();
        expect(() =>
          orderEventSchema.parse({ ...event, reason: 'r'.repeat(201) }),
        ).toThrow(ZodError);
      },
    );

    it('bounds the items to 50, the lines order-service accepts', () => {
      const items = (n: number) => Array.from({ length: n }, () => item);
      expect(() =>
        orderEventSchema.parse({ ...created(), items: items(50) }),
      ).not.toThrow();
      expect(() =>
        orderEventSchema.parse({ ...created(), items: items(51) }),
      ).toThrow(ZodError);
    });
  });
});

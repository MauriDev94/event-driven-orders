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
});

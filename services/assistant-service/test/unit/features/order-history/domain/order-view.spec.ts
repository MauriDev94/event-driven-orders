import { DomainError } from '../../../../../src/common/domain-error.js';
import type { OrderHistoryEvent } from '../../../../../src/features/order-history/domain/order-history-event.js';
import { OrderView } from '../../../../../src/features/order-history/domain/order-view.js';

const ORDER_ID = 'order-1';
const at = (second: number) => new Date(Date.UTC(2026, 9, 31, 12, 0, second));
const items = [{ productId: 'SKU-001', quantity: 2, unitPrice: '10.00' }];

const events = {
  created: (second = 0): OrderHistoryEvent => ({
    type: 'order.created',
    eventId: `created-${second}`,
    orderId: ORDER_ID,
    occurredAt: at(second),
    customerId: 'c-1',
    items,
    totalAmount: '20.00',
  }),
  reserved: (second = 1): OrderHistoryEvent => ({
    type: 'stock.reserved',
    eventId: `reserved-${second}`,
    orderId: ORDER_ID,
    occurredAt: at(second),
  }),
  stockRejected: (second = 1): OrderHistoryEvent => ({
    type: 'stock.rejected',
    eventId: `stock-rejected-${second}`,
    orderId: ORDER_ID,
    occurredAt: at(second),
    reason: 'insufficient stock for product SKU-001',
  }),
  confirmed: (second = 2): OrderHistoryEvent => ({
    type: 'order.confirmed',
    eventId: `confirmed-${second}`,
    orderId: ORDER_ID,
    occurredAt: at(second),
    customerId: 'c-1',
  }),
  rejected: (second = 2): OrderHistoryEvent => ({
    type: 'order.rejected',
    eventId: `rejected-${second}`,
    orderId: ORDER_ID,
    occurredAt: at(second),
    customerId: 'c-1',
    reason: 'insufficient stock for product SKU-001',
  }),
};

function project(...history: OrderHistoryEvent[]): OrderView {
  return history.reduce(
    (view, event) => view.apply(event),
    OrderView.start(ORDER_ID),
  );
}

describe('OrderView', () => {
  it('starts pending, with nothing known yet', () => {
    expect(OrderView.start(ORDER_ID).toState()).toEqual({
      orderId: ORDER_ID,
      customerId: null,
      status: 'pending',
      stockResult: null,
      rejectionReason: null,
      totalAmount: null,
      items: null,
      createdAt: null,
      lastEventAt: null,
    });
  });

  it('follows the confirmation flow', () => {
    expect(
      project(
        events.created(),
        events.reserved(),
        events.confirmed(),
      ).toState(),
    ).toEqual({
      orderId: ORDER_ID,
      customerId: 'c-1',
      status: 'confirmed',
      stockResult: 'reserved',
      rejectionReason: null,
      totalAmount: '20.00',
      items,
      createdAt: at(0),
      lastEventAt: at(2),
    });
  });

  it('follows the rejection flow and keeps the reason', () => {
    const view = project(
      events.created(),
      events.stockRejected(),
      events.rejected(),
    );

    expect(view).toMatchObject({
      status: 'rejected',
      stockResult: 'rejected',
      rejectionReason: 'insufficient stock for product SKU-001',
    });
  });

  it('accepts the stock result before order.created', () => {
    const view = project(events.reserved());

    expect(view).toMatchObject({
      status: 'pending',
      stockResult: 'reserved',
      customerId: null,
    });
  });

  it('lets a late order.created fill in the order without undoing its status', () => {
    const view = project(
      events.reserved(1),
      events.confirmed(2),
      events.created(0),
    );

    expect(view.toState()).toMatchObject({
      status: 'confirmed',
      stockResult: 'reserved',
      customerId: 'c-1',
      items,
      totalAmount: '20.00',
      createdAt: at(0),
      lastEventAt: at(2),
    });
  });

  it('treats a repeated confirmation as a no-op', () => {
    const view = project(
      events.created(),
      events.reserved(),
      events.confirmed(2),
      events.confirmed(3),
    );

    expect(view).toMatchObject({ status: 'confirmed', lastEventAt: at(3) });
  });

  it.each([
    ['a confirmed order', [events.confirmed()], events.rejected()],
    ['a rejected order', [events.rejected()], events.confirmed()],
    ['reserved stock', [events.reserved()], events.stockRejected()],
    ['rejected stock', [events.stockRejected()], events.reserved()],
  ])('refuses to flip %s', (_name, history, next) => {
    const view = project(...history);

    expect(() => view.apply(next)).toThrow(DomainError);
  });

  it('refuses an event of another order', () => {
    const other: OrderHistoryEvent = {
      ...events.reserved(),
      orderId: 'order-2',
    };

    expect(() => OrderView.start(ORDER_ID).apply(other)).toThrow(DomainError);
  });

  it('returns a new view and leaves the previous one untouched', () => {
    const before = OrderView.start(ORDER_ID);
    const after = before.apply(events.reserved());

    expect(before.stockResult).toBeNull();
    expect(after.stockResult).toBe('reserved');
  });
});

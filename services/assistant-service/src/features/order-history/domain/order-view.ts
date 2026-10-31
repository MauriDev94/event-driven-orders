import { DomainError } from '../../../common/domain-error.js';
import type {
  OrderHistoryEvent,
  OrderItem,
  OrderStatus,
  StockResult,
} from './order-history-event.js';

export interface OrderViewState {
  orderId: string;
  customerId: string | null;
  status: OrderStatus;
  stockResult: StockResult | null;
  rejectionReason: string | null;
  totalAmount: string | null;
  items: OrderItem[] | null;
  createdAt: Date | null;
  lastEventAt: Date | null;
}

/**
 * Current state of an order, rebuilt from its events. Immutable: `apply`
 * returns a new view.
 *
 * Retries can reorder events (a `stock.reserved` can arrive before its
 * `order.created`), so a view accepts them in any order:
 * - a terminal status (`confirmed`, `rejected`) never goes back to `pending`;
 * - a late `order.created` fills in customer, items and total without
 *   touching the status;
 * - an impossible flip (confirmed to rejected, reserved to rejected stock)
 *   throws DomainError, which sends the message to the DLQ.
 */
export class OrderView implements OrderViewState {
  readonly orderId: string;
  readonly customerId: string | null;
  readonly status: OrderStatus;
  readonly stockResult: StockResult | null;
  readonly rejectionReason: string | null;
  readonly totalAmount: string | null;
  readonly items: OrderItem[] | null;
  readonly createdAt: Date | null;
  readonly lastEventAt: Date | null;

  private constructor(state: OrderViewState) {
    this.orderId = state.orderId;
    this.customerId = state.customerId;
    this.status = state.status;
    this.stockResult = state.stockResult;
    this.rejectionReason = state.rejectionReason;
    this.totalAmount = state.totalAmount;
    this.items = state.items;
    this.createdAt = state.createdAt;
    this.lastEventAt = state.lastEventAt;
  }

  /** An order no event has been projected for yet. */
  static start(orderId: string): OrderView {
    return new OrderView({
      orderId,
      customerId: null,
      status: 'pending',
      stockResult: null,
      rejectionReason: null,
      totalAmount: null,
      items: null,
      createdAt: null,
      lastEventAt: null,
    });
  }

  static restore(state: OrderViewState): OrderView {
    return new OrderView(state);
  }

  toState(): OrderViewState {
    return {
      orderId: this.orderId,
      customerId: this.customerId,
      status: this.status,
      stockResult: this.stockResult,
      rejectionReason: this.rejectionReason,
      totalAmount: this.totalAmount,
      items: this.items,
      createdAt: this.createdAt,
      lastEventAt: this.lastEventAt,
    };
  }

  apply(event: OrderHistoryEvent): OrderView {
    if (event.orderId !== this.orderId) {
      throw new DomainError(
        `event ${event.eventId} belongs to order ${event.orderId}, not ${this.orderId}`,
      );
    }
    const next = this.toState();
    if (this.lastEventAt === null || event.occurredAt > this.lastEventAt) {
      next.lastEventAt = event.occurredAt;
    }

    switch (event.type) {
      case 'order.created':
        next.customerId ??= event.customerId;
        next.items ??= event.items;
        next.totalAmount ??= event.totalAmount;
        next.createdAt ??= event.occurredAt;
        break;
      case 'stock.reserved':
        this.refuseIf(
          this.stockResult === 'rejected',
          'its stock was rejected, it cannot be reserved',
        );
        next.stockResult = 'reserved';
        break;
      case 'stock.rejected':
        this.refuseIf(
          this.stockResult === 'reserved',
          'its stock was reserved, it cannot be rejected',
        );
        next.stockResult = 'rejected';
        next.rejectionReason ??= event.reason;
        break;
      case 'order.confirmed':
        this.refuseIf(
          this.status === 'rejected',
          'it was rejected, it cannot be confirmed',
        );
        next.status = 'confirmed';
        next.customerId ??= event.customerId;
        break;
      case 'order.rejected':
        this.refuseIf(
          this.status === 'confirmed',
          'it was confirmed, it cannot be rejected',
        );
        next.status = 'rejected';
        next.rejectionReason = event.reason;
        next.customerId ??= event.customerId;
        break;
    }
    return new OrderView(next);
  }

  private refuseIf(condition: boolean, reason: string): void {
    if (condition) {
      throw new DomainError(`order ${this.orderId}: ${reason}`);
    }
  }
}

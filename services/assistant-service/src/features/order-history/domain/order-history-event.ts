export type OrderStatus = 'pending' | 'confirmed' | 'rejected';

export type StockResult = 'reserved' | 'rejected';

export interface OrderItem {
  productId: string;
  quantity: number;
  /** Decimal as text, so amounts keep their exact value. */
  unitPrice: string;
}

interface EventMeta {
  eventId: string;
  orderId: string;
  occurredAt: Date;
}

/** What each integration event tells the history about an order. */
export type OrderHistoryEvent =
  | (EventMeta & {
      type: 'order.created';
      customerId: string;
      items: OrderItem[];
      totalAmount: string;
    })
  | (EventMeta & { type: 'stock.reserved' })
  | (EventMeta & { type: 'stock.rejected'; reason: string })
  | (EventMeta & { type: 'order.confirmed'; customerId: string })
  | (EventMeta & {
      type: 'order.rejected';
      customerId: string;
      reason: string;
    });

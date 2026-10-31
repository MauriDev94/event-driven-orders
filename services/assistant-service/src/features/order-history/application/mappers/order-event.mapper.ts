import type { OrderEventContract } from '../../../../core/messaging/contracts.js';
import type { OrderHistoryEvent } from '../../domain/order-history-event.js';
import type { ProjectOrderEventCommand } from '../usecases/project-order-event.js';

/** Wire contract (snake_case, ISO dates) to the domain event of the history. */
export function toProjectionCommand(
  contract: OrderEventContract,
): ProjectOrderEventCommand {
  const meta = {
    eventId: contract.event_id,
    orderId: contract.order_id,
    occurredAt: new Date(contract.occurred_at),
  };
  let event: OrderHistoryEvent;
  switch (contract.event_type) {
    case 'order.created':
      event = {
        ...meta,
        type: contract.event_type,
        customerId: contract.customer_id,
        items: contract.items.map((item) => ({
          productId: item.product_id,
          quantity: item.quantity,
          unitPrice: item.unit_price,
        })),
        totalAmount: contract.total_amount,
      };
      break;
    case 'stock.reserved':
      event = { ...meta, type: contract.event_type };
      break;
    case 'stock.rejected':
      event = { ...meta, type: contract.event_type, reason: contract.reason };
      break;
    case 'order.confirmed':
      event = {
        ...meta,
        type: contract.event_type,
        customerId: contract.customer_id,
      };
      break;
    case 'order.rejected':
      event = {
        ...meta,
        type: contract.event_type,
        customerId: contract.customer_id,
        reason: contract.reason,
      };
      break;
  }
  return { event, correlationId: contract.correlation_id, payload: contract };
}

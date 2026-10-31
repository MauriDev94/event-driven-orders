import type { OrderHistoryEvent } from '../../domain/order-history-event.js';
import { OrderView } from '../../domain/order-view.js';
import type { OrderHistoryRepository } from '../contracts/order-history.repository.js';
import type { TimelineCache } from '../contracts/timeline-cache.js';

export interface ProjectOrderEventCommand {
  event: OrderHistoryEvent;
  correlationId: string;
  payload: unknown;
}

export type ProjectionResult = 'projected' | 'duplicate';

/**
 * Applies one event to the read model. The event log insert is the
 * idempotency check (ADR-0006) and shares the transaction with the view, so a
 * redelivered event changes nothing and a failed one leaves no trace. The
 * cached timeline is dropped only after the commit, so a reader can't cache
 * the old state again from a transaction that hasn't committed yet.
 */
export class ProjectOrderEvent {
  constructor(
    private readonly repository: OrderHistoryRepository,
    private readonly cache: TimelineCache,
  ) {}

  async execute({
    event,
    correlationId,
    payload,
  }: ProjectOrderEventCommand): Promise<ProjectionResult> {
    const result = await this.repository.inTransaction(async (tx) => {
      const isNew = await tx.recordEvent({
        eventId: event.eventId,
        orderId: event.orderId,
        eventType: event.type,
        occurredAt: event.occurredAt,
        correlationId,
        payload,
      });
      if (!isNew) return 'duplicate';

      const stored = await tx.findView(event.orderId);
      const view = (stored?.view ?? OrderView.start(event.orderId)).apply(
        event,
      );
      await tx.saveView(view, stored?.version ?? null);
      return 'projected' as const;
    });
    if (result === 'projected') await this.cache.invalidate(event.orderId);
    return result;
  }
}

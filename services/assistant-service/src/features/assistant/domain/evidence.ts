/** An order the answer relies on, with the events the tools showed for it. */
export interface Citation {
  orderId: string;
  eventIds: string[];
}

/**
 * Every order and event the tools returned while answering one question. It
 * is the only source of citations: what the model says is checked against
 * it, never trusted on its own.
 */
export class Evidence {
  private readonly orders = new Map<string, Set<string>>();
  private readonly orderOfEvent = new Map<string, string>();

  add(orderId: string, eventIds: readonly string[] = []): void {
    const id = orderId.toLowerCase();
    const events = this.orders.get(id) ?? new Set<string>();
    for (const eventId of eventIds) {
      events.add(eventId.toLowerCase());
      this.orderOfEvent.set(eventId.toLowerCase(), id);
    }
    this.orders.set(id, events);
  }

  /** The order an order or event ID belongs to, if the tools returned it. */
  orderOf(id: string): string | undefined {
    const key = id.toLowerCase();
    return this.orders.has(key) ? key : this.orderOfEvent.get(key);
  }

  /** Citations for the given orders, or for all of them, in insertion order. */
  citations(only?: ReadonlySet<string>): Citation[] {
    return [...this.orders]
      .filter(([orderId]) => only === undefined || only.has(orderId))
      .map(([orderId, events]) => ({ orderId, eventIds: [...events] }));
  }
}

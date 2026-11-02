import { amountReturned, skusIn } from './facts.js';

/** An order the answer relies on, with the events the tools showed for it. */
export interface Citation {
  orderId: string;
  eventIds: string[];
}

/**
 * Every order, event, amount and SKU the tools returned while answering one
 * question. It is the only source of citations: what the model says is
 * checked against it, never trusted on its own.
 */
export class Evidence {
  private readonly orders = new Map<string, Set<string>>();
  private readonly orderOfEvent = new Map<string, string>();
  private readonly amounts = new Set<number>();
  private readonly skus = new Set<string>();

  add(orderId: string, eventIds: readonly string[] = []): void {
    const id = orderId.toLowerCase();
    const events = this.orders.get(id) ?? new Set<string>();
    for (const eventId of eventIds) {
      events.add(eventId.toLowerCase());
      this.orderOfEvent.set(eventId.toLowerCase(), id);
    }
    this.orders.set(id, events);
  }

  /**
   * Records the amounts and SKUs of a tool's output, wherever they appear in
   * it: totals, unit prices, product IDs and the SKU inside a rejection reason.
   */
  addValues(output: unknown): void {
    if (Array.isArray(output)) {
      for (const item of output) this.addValues(item);
      return;
    }
    if (output !== null && typeof output === 'object') {
      for (const value of Object.values(output)) this.addValues(value);
      return;
    }
    const amount = amountReturned(output);
    if (amount !== undefined) this.amounts.add(amount);
    if (typeof output === 'string') {
      for (const sku of skusIn(output)) this.skus.add(sku);
    }
  }

  /** Whether a tool returned this amount, in cents. */
  hasAmount(cents: number): boolean {
    return this.amounts.has(cents);
  }

  /** Whether a tool returned this SKU, upper-cased. */
  hasSku(sku: string): boolean {
    return this.skus.has(sku);
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

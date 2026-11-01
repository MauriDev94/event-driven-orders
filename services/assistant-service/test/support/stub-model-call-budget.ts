import { ModelCallBudget } from '../../src/features/assistant/application/contracts/model-call-budget.js';

/** Counts the calls taken; refuses past `limit`, or throws `error` if given. */
export class StubModelCallBudget extends ModelCallBudget {
  taken = 0;

  constructor(
    private readonly limit = Number.POSITIVE_INFINITY,
    private readonly error?: Error,
  ) {
    super();
  }

  async take(): Promise<boolean> {
    if (this.error !== undefined) throw this.error;
    this.taken += 1;
    return this.taken <= this.limit;
  }
}

/**
 * Daily budget of model calls, kept below the provider's daily quota
 * (ADR-0024). The rate limit is per client and per minute; this budget is
 * global and per day, so many clients together can't drain the quota.
 */
export abstract class ModelCallBudget {
  /** Takes one call from today's budget; false once it's spent. */
  abstract take(): Promise<boolean>;
}

/**
 * The budget can't be checked. The question is refused (fails closed), like
 * the rate limit: both exist to protect the model's free quota.
 */
export class ModelCallBudgetUnavailableError extends Error {
  override readonly name = 'ModelCallBudgetUnavailableError';
}

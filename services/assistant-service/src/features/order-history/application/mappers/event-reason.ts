/** The `reason` a rejection event carries in its payload, or null if it has none. */
export function reasonOf(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'reason' in payload) {
    return typeof payload.reason === 'string' ? payload.reason : null;
  }
  return null;
}

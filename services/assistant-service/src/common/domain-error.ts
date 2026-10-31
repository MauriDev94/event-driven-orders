/**
 * A business rule was violated, so retrying the message changes nothing: the
 * retry dispatcher sends it straight to the DLQ. It plays the role of
 * `ValueError` in the Python services.
 */
export class DomainError extends Error {
  override readonly name = 'DomainError';
}

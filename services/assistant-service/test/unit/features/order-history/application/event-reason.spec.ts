import { reasonOf } from '../../../../../src/features/order-history/application/mappers/event-reason.js';

describe('reasonOf', () => {
  it('returns the reason of a payload that has one', () => {
    expect(reasonOf({ reason: 'insufficient stock' })).toBe(
      'insufficient stock',
    );
  });

  it.each([{}, { reason: 3 }, null, 'text', undefined])(
    'returns null when the payload has no string reason: %j',
    (payload) => {
      expect(reasonOf(payload)).toBeNull();
    },
  );
});

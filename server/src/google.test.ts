import { describe, expect, it } from 'vitest';
import { isOwnerProblem, upstreamReason } from './google';

describe('upstreamReason', () => {
  it.each(['photo', 'network', 'unavailable', 'invalid_answer'] as const)('keeps %s', (reason) => {
    expect(upstreamReason(reason)).toBe(reason);
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing', 'quota'] as const)(
    'tells a client nothing about the key: %s reads as unavailable',
    (reason) => {
      expect(upstreamReason(reason)).toBe('unavailable');
    },
  );
});

describe('isOwnerProblem', () => {
  it.each(['invalid', 'restricted', 'disabled', 'billing', 'quota', 'unavailable'] as const)(
    '%s is the owner to fix',
    (reason) => {
      expect(isOwnerProblem(reason)).toBe(true);
    },
  );

  it.each(['photo', 'network', 'invalid_answer'] as const)('%s is not', (reason) => {
    expect(isOwnerProblem(reason)).toBe(false);
  });
});

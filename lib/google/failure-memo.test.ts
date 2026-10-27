import { describe, expect, it } from 'vitest';
import { KEY_FAILURE_MEMO_MS, TRANSIENT_FAILURE_MEMO_MS, createFailureMemo } from './failure-memo';

const KEY = 'AIzaKey';

function setup() {
  let clock = 1_000_000;
  const memo = createFailureMemo<string>(() => clock);
  return { memo, at: (ms: number) => (clock = 1_000_000 + ms) };
}

describe('createFailureMemo', () => {
  it('has the memory times the design says: 10 minutes for a key, 90 seconds for the rest', () => {
    expect(KEY_FAILURE_MEMO_MS).toBe(600_000);
    expect(TRANSIENT_FAILURE_MEMO_MS).toBe(90_000);
  });

  it('remembers nothing at first', () => {
    expect(setup().memo.recall(KEY)).toBeNull();
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing'])(
    'remembers a "%s" key for 10 minutes',
    (reason) => {
      const { memo, at } = setup();
      memo.remember(KEY, reason, memo.generation());
      at(KEY_FAILURE_MEMO_MS - 1);
      expect(memo.recall(KEY)).toBe(reason);
      at(KEY_FAILURE_MEMO_MS);
      expect(memo.recall(KEY)).toBeNull();
    },
  );

  it.each(['quota', 'network', 'unavailable'])('remembers "%s" for 90 seconds', (reason) => {
    const { memo, at } = setup();
    memo.remember(KEY, reason, memo.generation());
    at(TRANSIENT_FAILURE_MEMO_MS - 1);
    expect(memo.recall(KEY)).toBe(reason);
    at(TRANSIENT_FAILURE_MEMO_MS);
    expect(memo.recall(KEY)).toBeNull();
  });

  it.each(['photo', 'invalid_answer', 'something else'])('does not remember "%s"', (reason) => {
    const { memo } = setup();
    memo.remember(KEY, reason, memo.generation());
    expect(memo.recall(KEY)).toBeNull();
  });

  it('is for this very key only', () => {
    const { memo } = setup();
    memo.remember(KEY, 'billing', memo.generation());
    expect(memo.recall(`${KEY}2`)).toBeNull();
    expect(memo.recall(KEY)).toBe('billing');
  });

  it('skips a failure that passes by itself on a retry, but not a refused key', () => {
    const { memo } = setup();
    memo.remember(KEY, 'network', memo.generation());
    expect(memo.recall(KEY, true)).toBeNull();
    expect(memo.recall(KEY, false)).toBe('network');
    memo.remember(KEY, 'invalid', memo.generation());
    expect(memo.recall(KEY, true)).toBe('invalid');
  });

  it('keeps one memory: the last failure that deserves it replaces the one before', () => {
    const { memo, at } = setup();
    memo.remember(KEY, 'invalid', memo.generation());
    at(10);
    memo.remember(KEY, 'network', memo.generation());
    expect(memo.recall(KEY)).toBe('network');
    memo.remember(KEY, 'photo', memo.generation());
    // A failure that is not remembered leaves the memory as it was.
    expect(memo.recall(KEY)).toBe('network');
  });

  describe('a failure that comes in late', () => {
    it('is ignored when a success or a fixed key forgot the memory since the call started', () => {
      const { memo } = setup();
      const started = memo.generation();
      memo.forget();
      memo.remember(KEY, 'network', started);
      expect(memo.recall(KEY)).toBeNull();
    });

    it('never overwrites a memory made after the call started', () => {
      const { memo } = setup();
      const slow = memo.generation();
      memo.forget();
      memo.remember(KEY, 'invalid', memo.generation());
      memo.remember(KEY, 'network', slow);
      expect(memo.recall(KEY)).toBe('invalid');
    });

    it('is remembered when nothing happened since the call started', () => {
      const { memo } = setup();
      const started = memo.generation();
      memo.remember(KEY, 'quota', started);
      expect(memo.recall(KEY)).toBe('quota');
      // A second failure from calls of the same generation keeps the last one.
      memo.remember(KEY, 'network', started);
      expect(memo.recall(KEY)).toBe('network');
    });

    it('moves on with every forget', () => {
      const { memo } = setup();
      const first = memo.generation();
      memo.forget();
      expect(memo.generation()).toBe(first + 1);
      memo.forget();
      expect(memo.generation()).toBe(first + 2);
    });
  });

  it('forgets on demand', () => {
    const { memo } = setup();
    memo.remember(KEY, 'quota', memo.generation());
    memo.forget();
    expect(memo.recall(KEY)).toBeNull();
  });
});

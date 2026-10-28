import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit';
import { fakeClock } from './test-helpers';

function limiter(limit = 3, windowMs = 60_000) {
  const clock = fakeClock();
  return { clock, limiter: createRateLimiter({ limit, windowMs, now: clock.ms }) };
}

describe('createRateLimiter', () => {
  it('allows `limit` hits, then refuses', () => {
    const { limiter: l } = limiter();
    expect([1, 2, 3].map(() => l.hit('a').allowed)).toEqual([true, true, true]);
    expect(l.hit('a').allowed).toBe(false);
    expect(l.hit('a').allowed).toBe(false);
  });

  it('keeps keys apart', () => {
    const { limiter: l } = limiter(1);
    expect(l.hit('a').allowed).toBe(true);
    expect(l.hit('b').allowed).toBe(true);
    expect(l.hit('a').allowed).toBe(false);
  });

  it('slides: a hit is forgotten exactly one window after it was made', () => {
    const { limiter: l, clock } = limiter(2, 60_000);
    l.hit('a'); // t = 0
    clock.advance(30_000);
    l.hit('a'); // t = 30 s
    expect(l.hit('a').allowed).toBe(false);

    clock.advance(29_999); // t = 59.999 s: the first hit is still inside
    expect(l.hit('a').allowed).toBe(false);
    clock.advance(1); // t = 60 s: the first hit is out, the second is not
    expect(l.hit('a').allowed).toBe(true);
    expect(l.hit('a').allowed).toBe(false);
  });

  it('says how long to wait, in whole seconds', () => {
    const { limiter: l, clock } = limiter(1, 60_000);
    l.hit('a');
    clock.advance(20_500);
    expect(l.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it('does not count a refused hit', () => {
    const { limiter: l, clock } = limiter(1, 60_000);
    l.hit('a');
    clock.advance(30_000);
    for (let i = 0; i < 10; i++) l.hit('a');
    clock.advance(30_000);
    expect(l.hit('a').allowed).toBe(true);
  });

  it('forgets idle keys, so the table does not grow for ever', () => {
    const { limiter: l, clock } = limiter(1, 60_000);
    for (let i = 0; i < 1000; i++) l.hit(`ip-${i}`);
    clock.advance(120_000);
    // A later hit sweeps; the old keys are gone and start from zero again.
    expect(l.hit('ip-0').allowed).toBe(true);
    expect(l.hit('ip-1').allowed).toBe(true);
  });
});

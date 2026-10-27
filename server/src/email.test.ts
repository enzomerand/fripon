import { describe, expect, it } from 'vitest';
import { canonicalEmail } from './email';

describe('canonicalEmail', () => {
  it.each([
    ['jo@example.com', 'jo@example.com'],
    ['Jo@Example.COM', 'jo@example.com'],
    ['jo+shop@example.com', 'jo@example.com'],
    ['jo+a+b@example.com', 'jo@example.com'],
    // The dots mean something outside Gmail: they stay.
    ['jo.doe@example.com', 'jo.doe@example.com'],
    ['jo.doe+tag@example.com', 'jo.doe@example.com'],
    ['jo.doe@gmail.com', 'jodoe@gmail.com'],
    ['J.o.D.o.e+x@Gmail.com', 'jodoe@gmail.com'],
    ['jo.doe@googlemail.com', 'jodoe@gmail.com'],
    ['jodoe+tag@googlemail.com', 'jodoe@gmail.com'],
    // Another domain is not Gmail, even when it looks like it.
    ['jo.doe@gmail.fr', 'jo.doe@gmail.fr'],
    ['jo.doe@notgmail.com', 'jo.doe@notgmail.com'],
  ])('%s is %s', (typed, canonical) => {
    expect(canonicalEmail(typed)).toBe(canonical);
  });

  it('keeps what was typed when removing the tag or the dots would leave nothing', () => {
    expect(canonicalEmail('+tag@example.com')).toBe('+tag@example.com');
    expect(canonicalEmail('..@gmail.com')).toBe('..@gmail.com');
  });

  it('is idempotent', () => {
    for (const typed of ['J.O+x@googlemail.com', 'a+b@c.d', 'x.y@z.fr']) {
      expect(canonicalEmail(canonicalEmail(typed))).toBe(canonicalEmail(typed));
    }
  });
});

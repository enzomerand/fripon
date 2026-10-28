import { describe, expect, it } from 'vitest';
import { isTinyThumbnail, photoKey } from './photo-url';

describe('isTinyThumbnail', () => {
  it.each(['/t/x/100x100/a.jpeg', '/t/x/70x100/a.jpeg', '/t/x/100x50/a.jpeg'])(
    '%s is tiny',
    (path) => {
      expect(isTinyThumbnail(path)).toBe(true);
    },
  );

  it.each(['/t/x/310x430/a.jpeg', '/t/x/f800/a.jpeg', '/t/x/101x101/a.jpeg', '/t/x/a.jpeg'])(
    '%s is not',
    (path) => {
      expect(isTinyThumbnail(path)).toBe(false);
    },
  );
});

describe('photoKey', () => {
  it('is the origin and the path: the signature of the query string does not count', () => {
    expect(photoKey('https://images1.vinted.net/t/x/f800/a.jpeg?s=abc#frag')).toBe(
      'https://images1.vinted.net/t/x/f800/a.jpeg',
    );
    expect(photoKey('https://images1.vinted.net/t/x/f800/a.jpeg?s=other')).toBe(
      photoKey('https://images1.vinted.net/t/x/f800/a.jpeg'),
    );
  });

  it('throws on something that is not a URL', () => {
    expect(() => photoKey('nope')).toThrow();
  });
});

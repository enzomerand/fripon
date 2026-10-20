import { describe, expect, it } from 'vitest';
import { formatCount, formatMoney, formatRatio, formatReset, maskKey } from './format';

/** Intl uses no-break spaces; tests compare against plain spaces. */
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('formatMoney', () => {
  it('formats euros the French way', () => {
    expect(plain(formatMoney({ amount: 8.99, currency: 'EUR' }))).toBe('8,99 €');
    expect(plain(formatMoney({ amount: 1234.5, currency: 'EUR' }))).toBe('1 234,50 €');
  });

  it('formats other currencies', () => {
    expect(plain(formatMoney({ amount: 12, currency: 'GBP' }))).toBe('12,00 £GB');
  });

  it('falls back on an invalid currency code', () => {
    expect(formatMoney({ amount: 5, currency: 'nope!' })).toBe('5 nope!');
  });
});

describe('formatRatio', () => {
  it('uses a decimal comma and drops a trailing zero', () => {
    expect(formatRatio(3.84)).toBe('3,8');
    expect(formatRatio(2)).toBe('2');
  });
});

describe('formatCount', () => {
  it('groups thousands the French way', () => {
    expect(plain(formatCount(12))).toBe('12');
    expect(plain(formatCount(1000))).toBe('1 000');
    expect(plain(formatCount(1234567))).toBe('1 234 567');
  });
});

describe('maskKey', () => {
  it('keeps the first and last four characters', () => {
    expect(maskKey('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q')).toBe('AIza••••••5P6Q');
  });

  it('hides a short key entirely', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('abcd')).toBe('••••');
    expect(maskKey('12345678')).toBe('••••••••');
    expect(maskKey('123456789')).toBe('1234••••••6789');
  });
});

describe('formatReset', () => {
  // Local-time dates throughout: the function reads the user's own clock.
  const now = new Date(2026, 9, 20, 14, 30);

  it('gives just the time when the reset is within a day', () => {
    expect(formatReset(new Date(2026, 9, 21, 9, 0), now)).toBe('à 9 h');
    expect(formatReset(new Date(2026, 9, 20, 23, 0), now)).toBe('à 23 h');
  });

  it('writes minutes when the offset is not a whole hour', () => {
    expect(formatReset(new Date(2026, 9, 21, 13, 30), now)).toBe('à 13 h 30');
    expect(formatReset(new Date(2026, 9, 21, 12, 5), now)).toBe('à 12 h 05');
  });

  it('adds the date for a later reset, with "1er" for the first of the month', () => {
    expect(formatReset(new Date(2026, 10, 1, 9, 0), now)).toBe('le 1er novembre à 9 h');
    expect(formatReset(new Date(2026, 11, 1, 8, 0), new Date(2026, 10, 3))).toBe(
      'le 1er décembre à 8 h',
    );
  });

  it('writes other days as plain numbers', () => {
    expect(formatReset(new Date(2026, 9, 25, 9, 0), now)).toBe('le 25 octobre à 9 h');
  });

  it('adds the year when the reset is next year', () => {
    expect(formatReset(new Date(2027, 0, 1, 9, 0), new Date(2026, 11, 15))).toBe(
      'le 1er janvier 2027 à 9 h',
    );
  });

  it('still says only the time on a 25-hour day', () => {
    const start = new Date('2026-11-01T05:00:00Z');
    expect(formatReset(new Date(start.getTime() + 25 * 3_600_000), start)).toMatch(/^à \d+ h/);
  });
});

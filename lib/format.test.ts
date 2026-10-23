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

  it('gives just the time when the reset is later today', () => {
    expect(formatReset(new Date(2026, 9, 20, 23, 0), now)).toBe('à 23 h');
    expect(formatReset(new Date(2026, 9, 20, 9, 0), new Date(2026, 9, 20, 7, 0))).toBe('à 9 h');
  });

  it('says tomorrow when the reset is on the next local day, even within 24 h', () => {
    expect(formatReset(new Date(2026, 9, 21, 9, 0), now)).toBe('demain à 9 h');
    // 9 h later, but after midnight.
    expect(formatReset(new Date(2026, 9, 21, 0, 30), new Date(2026, 9, 20, 23, 30))).toBe(
      'demain à 0 h 30',
    );
    expect(formatReset(new Date(2026, 10, 1, 8, 0), new Date(2026, 9, 31, 20, 0))).toBe(
      'demain à 8 h',
    );
  });

  it('writes minutes when the offset is not a whole hour', () => {
    expect(formatReset(new Date(2026, 9, 20, 22, 30), now)).toBe('à 22 h 30');
    expect(formatReset(new Date(2026, 9, 21, 12, 5), now)).toBe('demain à 12 h 05');
  });

  it('adds the date for a later reset, with "1er" for the first of the month', () => {
    expect(formatReset(new Date(2026, 10, 1, 9, 0), now)).toBe('le 1er novembre à 9 h');
    expect(formatReset(new Date(2026, 11, 1, 8, 0), new Date(2026, 10, 3))).toBe(
      'le 1er décembre à 8 h',
    );
  });

  it('does not call the day after tomorrow "tomorrow", even within 25 h', () => {
    // 25 h later, which is two calendar days on.
    expect(formatReset(new Date(2026, 9, 22, 0, 30), new Date(2026, 9, 20, 23, 30))).toBe(
      'le 22 octobre à 0 h 30',
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

  it('counts calendar days across the end of the year and a daylight saving change', () => {
    expect(formatReset(new Date(2027, 0, 1, 9, 0), new Date(2026, 11, 31, 22, 0))).toBe(
      'demain à 9 h',
    );
    expect(formatReset(new Date(2026, 9, 26, 9, 0), new Date(2026, 9, 25, 12, 0))).toBe(
      'demain à 9 h',
    );
  });
});

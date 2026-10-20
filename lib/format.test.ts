import { describe, expect, it } from 'vitest';
import { formatCount, formatMoney, formatRatio, formatResetDate, maskKey } from './format';

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

describe('formatResetDate', () => {
  const now = new Date(2026, 9, 20, 14, 30);

  it('says tomorrow for a daily reset', () => {
    expect(formatResetDate(new Date(2026, 9, 21), now)).toBe('demain');
    expect(formatResetDate(new Date(2026, 10, 1), new Date(2026, 9, 31, 23, 59))).toBe('demain');
  });

  it('writes the 1st as "1er" and the month in full', () => {
    expect(formatResetDate(new Date(2026, 10, 1), now)).toBe('le 1er novembre');
    expect(formatResetDate(new Date(2026, 11, 1), new Date(2026, 10, 3))).toBe('le 1er décembre');
  });

  it('writes other days as plain numbers', () => {
    expect(formatResetDate(new Date(2026, 9, 25), now)).toBe('le 25 octobre');
  });

  it('adds the year when the reset is next year', () => {
    expect(formatResetDate(new Date(2027, 0, 1), new Date(2026, 11, 15))).toBe(
      'le 1er janvier 2027',
    );
  });
});

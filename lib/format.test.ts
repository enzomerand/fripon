import { describe, expect, it } from 'vitest';
import { formatMoney, formatRatio } from './format';

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

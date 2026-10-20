import { describe, expect, it } from 'vitest';
import { accountAgeDays, formatAccountAge, formatMoney, formatRatio } from './format';

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

describe('formatAccountAge', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  it.each([
    [0, "aujourd'hui"],
    [1, 'il y a 1 jour'],
    [5, 'il y a 5 jours'],
    [7, 'il y a 1 semaine'],
    [21, 'il y a 3 semaines'],
    [29, 'il y a 4 semaines'],
    [31, 'il y a 1 mois'],
    [200, 'il y a 6 mois'],
    [364, 'il y a 11 mois'],
    [365, 'il y a 1 an'],
    [800, 'il y a 2 ans'],
  ])('%i days ago -> %s', (days, expected) => {
    expect(formatAccountAge(daysAgo(days), now)).toBe(expected);
  });

  it('never goes negative for a date in the future', () => {
    expect(formatAccountAge(daysAgo(-3), now)).toBe("aujourd'hui");
  });

  it('returns an empty string for a missing or invalid date', () => {
    expect(formatAccountAge(null, now)).toBe('');
    expect(formatAccountAge('not a date', now)).toBe('');
    expect(accountAgeDays('not a date', now)).toBeNull();
  });
});

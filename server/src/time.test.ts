import { describe, expect, it } from 'vitest';
import { periodIds } from './time';

const ids = (iso: string) => periodIds(new Date(iso));

describe('periodIds', () => {
  it('gives the month and the day of the Paris calendar', () => {
    expect(ids('2026-10-20T12:00:00Z')).toEqual({ month: '2026-10', day: '2026-10-20' });
  });

  it('is not UTC: 23:30 UTC in summer is already tomorrow in Paris (UTC+2)', () => {
    expect(ids('2026-07-14T21:59:59Z').day).toBe('2026-07-14');
    expect(ids('2026-07-14T22:00:00Z').day).toBe('2026-07-15');
  });

  it('changes the month at Paris midnight (summer time)', () => {
    expect(ids('2026-07-31T21:59:59Z')).toEqual({ month: '2026-07', day: '2026-07-31' });
    expect(ids('2026-07-31T22:00:00Z')).toEqual({ month: '2026-08', day: '2026-08-01' });
  });

  it('changes the month at Paris midnight (winter time, UTC+1)', () => {
    expect(ids('2026-10-31T22:59:59Z')).toEqual({ month: '2026-10', day: '2026-10-31' });
    expect(ids('2026-10-31T23:00:00Z')).toEqual({ month: '2026-11', day: '2026-11-01' });
  });

  it('changes the year', () => {
    expect(ids('2026-12-31T22:59:59Z')).toEqual({ month: '2026-12', day: '2026-12-31' });
    expect(ids('2026-12-31T23:00:00Z')).toEqual({ month: '2027-01', day: '2027-01-01' });
  });

  it('keeps the day lengths right across the spring change (29 March 2026, 23 hours)', () => {
    // Midnight is still UTC+1 on the 29th (the clock jumps at 02:00), so the 29th starts at 23:00Z.
    expect(ids('2026-03-28T22:59:59Z').day).toBe('2026-03-28');
    expect(ids('2026-03-28T23:00:00Z').day).toBe('2026-03-29');
    // The 30th starts at UTC+2, an hour earlier in UTC.
    expect(ids('2026-03-29T21:59:59Z').day).toBe('2026-03-29');
    expect(ids('2026-03-29T22:00:00Z').day).toBe('2026-03-30');
  });

  it('keeps the day lengths right across the autumn change (25 October 2026, 25 hours)', () => {
    expect(ids('2026-10-24T21:59:59Z').day).toBe('2026-10-24');
    expect(ids('2026-10-24T22:00:00Z').day).toBe('2026-10-25');
    // 02:30 happens twice that night; both belong to the 25th.
    expect(ids('2026-10-25T00:30:00Z').day).toBe('2026-10-25');
    expect(ids('2026-10-25T01:30:00Z').day).toBe('2026-10-25');
    // The 26th starts at UTC+1: 23:00Z, an hour later than the 25th's 22:00Z start.
    expect(ids('2026-10-25T22:59:59Z').day).toBe('2026-10-25');
    expect(ids('2026-10-25T23:00:00Z').day).toBe('2026-10-26');
  });
});

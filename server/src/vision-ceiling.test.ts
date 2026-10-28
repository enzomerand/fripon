import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callsOn, giveBackCall } from './daily-ceiling';
import { openDb, type Db } from './db';
import { takeVisionCall, trialVisionCap } from './vision-ceiling';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

describe('the global Vision ceiling', () => {
  it('lets calls through up to the cap, then refuses without counting', () => {
    expect(takeVisionCall(db, '2026-10-20', 2)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 2)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 2)).toBe(false);
    expect(takeVisionCall(db, '2026-10-20', 2)).toBe(false);
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(2);
  });

  it('counts each day on its own', () => {
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(false);
    expect(takeVisionCall(db, '2026-10-21', 1)).toBe(true);
    expect(callsOn(db, 'vision_calls', '2026-10-21')).toBe(1);
  });

  it('gives a call back, never below zero', () => {
    takeVisionCall(db, '2026-10-20', 1);
    giveBackCall(db, 'vision_calls', '2026-10-20');
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(0);
    giveBackCall(db, 'vision_calls', '2026-10-20');
    giveBackCall(db, 'vision_calls', '2026-10-22');
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(0);
    // The freed call can be taken again.
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(true);
  });

  it('counts 0 for a day nobody searched in', () => {
    expect(callsOn(db, 'vision_calls', '2030-01-01')).toBe(0);
  });
});

describe("the trials' share of the Vision ceiling", () => {
  const trialCalls = (day: string) =>
    (
      db.prepare('SELECT trial_count AS n FROM vision_calls WHERE day = ?').get(day) as {
        n: number;
      }
    ).n;

  it('is 20% of the cap, and at least one call', () => {
    expect(trialVisionCap(3_000)).toBe(600);
    expect(trialVisionCap(100)).toBe(20);
    expect(trialVisionCap(7)).toBe(1);
    expect(trialVisionCap(1)).toBe(1);
  });

  it('refuses a trial call past the share, with room left, and lets a subscriber through', () => {
    for (let i = 0; i < 2; i++) expect(takeVisionCall(db, '2026-10-20', 10, true)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 10, true)).toBe(false);
    // Nothing was counted for the refused one, and the subscribers still have the rest of the cap.
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(2);
    for (let i = 0; i < 8; i++) expect(takeVisionCall(db, '2026-10-20', 10)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 10)).toBe(false);
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(10);
    expect(trialCalls('2026-10-20')).toBe(2);
  });

  it('still obeys the whole cap: subscribers who used it all leave no call for a trial', () => {
    for (let i = 0; i < 10; i++) takeVisionCall(db, '2026-10-20', 10);
    expect(takeVisionCall(db, '2026-10-20', 10, true)).toBe(false);
    expect(trialCalls('2026-10-20')).toBe(0);
  });

  it('gives a trial call back to both counts, and a subscriber one to the total only', () => {
    takeVisionCall(db, '2026-10-20', 10, true);
    takeVisionCall(db, '2026-10-20', 10);
    giveBackCall(db, 'vision_calls', '2026-10-20', true);
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(1);
    expect(trialCalls('2026-10-20')).toBe(0);
    giveBackCall(db, 'vision_calls', '2026-10-20');
    giveBackCall(db, 'vision_calls', '2026-10-20', true);
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(0);
    expect(trialCalls('2026-10-20')).toBe(0);
  });

  it('counts each day on its own', () => {
    for (let i = 0; i < 2; i++) takeVisionCall(db, '2026-10-20', 10, true);
    expect(takeVisionCall(db, '2026-10-21', 10, true)).toBe(true);
  });
});

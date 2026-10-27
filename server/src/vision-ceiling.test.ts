import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { giveBackVisionCall, takeVisionCall, visionCallsOn } from './vision-ceiling';

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
    expect(visionCallsOn(db, '2026-10-20')).toBe(2);
  });

  it('counts each day on its own', () => {
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(true);
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(false);
    expect(takeVisionCall(db, '2026-10-21', 1)).toBe(true);
    expect(visionCallsOn(db, '2026-10-21')).toBe(1);
  });

  it('gives a call back, never below zero', () => {
    takeVisionCall(db, '2026-10-20', 1);
    giveBackVisionCall(db, '2026-10-20');
    expect(visionCallsOn(db, '2026-10-20')).toBe(0);
    giveBackVisionCall(db, '2026-10-20');
    giveBackVisionCall(db, '2026-10-22');
    expect(visionCallsOn(db, '2026-10-20')).toBe(0);
    // The freed call can be taken again.
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(true);
  });

  it('counts 0 for a day nobody searched in', () => {
    expect(visionCallsOn(db, '2030-01-01')).toBe(0);
  });
});

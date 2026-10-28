import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callsOn, giveBackCall, takeCall } from './daily-ceiling';
import { openDb, type Db } from './db';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

describe('the global Gemini ceiling (gemini_calls)', () => {
  it('lets calls through up to the cap, then refuses without counting', () => {
    expect(takeCall(db, 'gemini_calls', '2026-10-20', 2)).toBe(true);
    expect(takeCall(db, 'gemini_calls', '2026-10-20', 2)).toBe(true);
    expect(takeCall(db, 'gemini_calls', '2026-10-20', 2)).toBe(false);
    expect(callsOn(db, 'gemini_calls', '2026-10-20')).toBe(2);
  });

  it('counts each day on its own, and gives a call back, never below zero', () => {
    takeCall(db, 'gemini_calls', '2026-10-20', 1);
    expect(takeCall(db, 'gemini_calls', '2026-10-21', 1)).toBe(true);
    giveBackCall(db, 'gemini_calls', '2026-10-20');
    giveBackCall(db, 'gemini_calls', '2026-10-20');
    expect(callsOn(db, 'gemini_calls', '2026-10-20')).toBe(0);
    expect(takeCall(db, 'gemini_calls', '2026-10-20', 1)).toBe(true);
  });

  it('is not the Vision ceiling: each service counts in its own table', () => {
    expect(takeCall(db, 'vision_calls', '2026-10-20', 1)).toBe(true);
    expect(takeCall(db, 'gemini_calls', '2026-10-20', 1)).toBe(true);
    expect(callsOn(db, 'vision_calls', '2026-10-20')).toBe(1);
    expect(callsOn(db, 'gemini_calls', '2026-10-20')).toBe(1);
  });
});

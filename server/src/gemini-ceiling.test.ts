import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { giveBackGeminiCall, geminiCallsOn, takeGeminiCall } from './gemini-ceiling';
import { takeVisionCall, visionCallsOn } from './vision-ceiling';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

describe('the global Gemini ceiling', () => {
  it('lets calls through up to the cap, then refuses without counting', () => {
    expect(takeGeminiCall(db, '2026-10-20', 2)).toBe(true);
    expect(takeGeminiCall(db, '2026-10-20', 2)).toBe(true);
    expect(takeGeminiCall(db, '2026-10-20', 2)).toBe(false);
    expect(geminiCallsOn(db, '2026-10-20')).toBe(2);
  });

  it('counts each day on its own, and gives a call back, never below zero', () => {
    takeGeminiCall(db, '2026-10-20', 1);
    expect(takeGeminiCall(db, '2026-10-21', 1)).toBe(true);
    giveBackGeminiCall(db, '2026-10-20');
    giveBackGeminiCall(db, '2026-10-20');
    expect(geminiCallsOn(db, '2026-10-20')).toBe(0);
    expect(takeGeminiCall(db, '2026-10-20', 1)).toBe(true);
  });

  it('is not the Vision ceiling: each service counts in its own table', () => {
    expect(takeVisionCall(db, '2026-10-20', 1)).toBe(true);
    expect(takeGeminiCall(db, '2026-10-20', 1)).toBe(true);
    expect(visionCallsOn(db, '2026-10-20')).toBe(1);
    expect(geminiCallsOn(db, '2026-10-20')).toBe(1);
  });
});

import { callsOn, giveBackCall, takeCall } from './daily-ceiling';
import type { Db } from './db';

/**
 * The global Gemini ceiling: paid AI reviews per day (Pacific time, like Google's quota), all
 * accounts together. Its own table, the same mechanism as the Vision ceiling: see `daily-ceiling.ts`.
 */

/** Takes one Gemini call of the day's ceiling; false (nothing counted) when `cap` were taken. */
export function takeGeminiCall(db: Db, day: string, cap: number): boolean {
  return takeCall(db, 'gemini_calls', day, cap);
}

/** Gives back a call `takeGeminiCall` counted, because the call was never billed. */
export function giveBackGeminiCall(db: Db, day: string): void {
  giveBackCall(db, 'gemini_calls', day);
}

/** Calls counted for `day` (a day nobody asked a review in counts 0). */
export function geminiCallsOn(db: Db, day: string): number {
  return callsOn(db, 'gemini_calls', day);
}

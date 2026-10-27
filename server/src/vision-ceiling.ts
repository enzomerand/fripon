import { callsOn, giveBackCall, takeCall } from './daily-ceiling';
import type { Db } from './db';

/**
 * The global Vision ceiling: paid Vision calls per day (Pacific time, like Google's quota), all
 * accounts together. See `daily-ceiling.ts`.
 */

/** Takes one Vision call of the day's ceiling; false (nothing counted) when `cap` were taken. */
export function takeVisionCall(db: Db, day: string, cap: number): boolean {
  return takeCall(db, 'vision_calls', day, cap);
}

/** Gives back a call `takeVisionCall` counted, because the call was never billed. */
export function giveBackVisionCall(db: Db, day: string): void {
  giveBackCall(db, 'vision_calls', day);
}

/** Calls counted for `day` (a day nobody searched in counts 0). */
export function visionCallsOn(db: Db, day: string): number {
  return callsOn(db, 'vision_calls', day);
}

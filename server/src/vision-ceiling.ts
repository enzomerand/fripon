import { takeCall } from './daily-ceiling';
import type { Db } from './db';

/**
 * The global Vision ceiling: paid Vision calls per day (Pacific time, like Google's quota), all
 * accounts together. See `daily-ceiling.ts`.
 */

/** The part of the day's ceiling the free trials may use together: a bot farm of trial accounts cannot drain it. */
export const TRIAL_VISION_SHARE = 0.2;

/** Vision calls a day's free trials may take under `cap` (at least one: a small cap still serves a trial). */
export const trialVisionCap = (cap: number): number =>
  Math.max(1, Math.floor(cap * TRIAL_VISION_SHARE));

/**
 * Takes one Vision call of the day's ceiling; false (nothing counted) when `cap` were taken, or,
 * for a call made for a free-trial account (`trial`), when its share of the ceiling is used up.
 */
export function takeVisionCall(db: Db, day: string, cap: number, trial = false): boolean {
  return trial
    ? takeCall(db, 'vision_calls', day, cap, trialVisionCap(cap))
    : takeCall(db, 'vision_calls', day, cap);
}

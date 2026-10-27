import type { Db } from './db';

/**
 * The global ceiling: paid Vision calls per day (Paris), all accounts together. It sits on top of
 * the Google Cloud quota and the budget alert, so a bug or an abuse cannot spend more than a known
 * amount in a day. Like the quotas, each write is one `BEGIN IMMEDIATE` transaction.
 */

/**
 * Takes one call of the day's ceiling. False when `cap` calls were already taken: nothing is
 * counted then. Give it back with `giveBackVisionCall` when Google certainly did not bill the call.
 */
export function takeVisionCall(db: Db, day: string, cap: number): boolean {
  return db
    .transaction((): boolean => {
      db.prepare(
        'INSERT INTO vision_calls (day, count) VALUES (?, 0) ON CONFLICT (day) DO NOTHING',
      ).run(day);
      const taken = db
        .prepare('UPDATE vision_calls SET count = count + 1 WHERE day = ? AND count < ?')
        .run(day, cap);
      return taken.changes > 0;
    })
    .immediate();
}

/** Gives back a call `takeVisionCall` counted, because the call was never billed. */
export function giveBackVisionCall(db: Db, day: string): void {
  db.prepare('UPDATE vision_calls SET count = MAX(count - 1, 0) WHERE day = ?').run(day);
}

/** Calls counted for `day` (a day nobody searched in counts 0). */
export function visionCallsOn(db: Db, day: string): number {
  const row = db.prepare('SELECT count FROM vision_calls WHERE day = ?').get(day) as
    { count: number } | undefined;
  return row?.count ?? 0;
}

import type { Db } from './db';

/**
 * A global ceiling: paid Google calls per day, all accounts together. It sits on top of the Google
 * Cloud quota and the budget alert, so a bug or an abuse cannot spend more than a known amount in
 * a day. One table per service (`vision_calls`, `gemini_calls`), each a counter per day; like the
 * quotas, each write is one `BEGIN IMMEDIATE` transaction. The day is the caller's: Google resets
 * its own quotas at midnight Pacific time (`GOOGLE_TIME_ZONE` in `time.ts`).
 */
export type CeilingTable = 'vision_calls' | 'gemini_calls';

/**
 * Takes one call of the day's ceiling. False when `cap` calls were already taken: nothing is
 * counted then. Give it back with `giveBackCall` when Google certainly did not bill the call.
 */
export function takeCall(db: Db, table: CeilingTable, day: string, cap: number): boolean {
  // `table` is one of the literals above, never user input.
  return db
    .transaction((): boolean => {
      db.prepare(
        `INSERT INTO ${table} (day, count) VALUES (?, 0) ON CONFLICT (day) DO NOTHING`,
      ).run(day);
      const taken = db
        .prepare(`UPDATE ${table} SET count = count + 1 WHERE day = ? AND count < ?`)
        .run(day, cap);
      return taken.changes > 0;
    })
    .immediate();
}

/** Gives back a call `takeCall` counted, because the call was never billed. */
export function giveBackCall(db: Db, table: CeilingTable, day: string): void {
  db.prepare(`UPDATE ${table} SET count = MAX(count - 1, 0) WHERE day = ?`).run(day);
}

/** Calls counted for `day` (a day nobody called in counts 0). */
export function callsOn(db: Db, table: CeilingTable, day: string): number {
  const row = db.prepare(`SELECT count FROM ${table} WHERE day = ?`).get(day) as
    { count: number } | undefined;
  return row?.count ?? 0;
}

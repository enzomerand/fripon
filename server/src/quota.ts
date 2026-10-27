import type { Account, Db } from './db';
import { entitlement, TRIAL_ANALYSES, type Entitlement, type PlanName } from './plans';
import { periodIds } from './time';

/**
 * What an analysis costs, and the only code that decides it. 1 analysis = the first image search
 * served to an account for a photo in a calendar month (Paris), whether Google or the shared
 * cache answered. The photo again the same month is free, and so is the AI review that follows
 * (see `allowReview`).
 *
 * Every write here is one SQLite transaction taken with `BEGIN IMMEDIATE`: the write lock is held
 * from the first read, so two requests (or two processes) can never both see room for one more.
 */

/** Why an analysis was refused. `day`/`month`: the plan's cap. `trial`: the free trial is used up
 *  and the account never subscribed. `none`: no usable subscription (it ended, or no account). */
export type DenyReason = 'day' | 'month' | 'trial' | 'none';

export type Reservation =
  /** The photo was already served this month: nothing is charged and there is nothing to undo. */
  | { ok: true; charged: false }
  /** One analysis was charged. If the work then fails (Google down...), call `release()`: once. */
  | { ok: true; charged: true; release: () => void }
  | { ok: false; reason: DenyReason };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The AI review only follows an image search served this recently. */
export const REVIEW_WINDOW_MS = 7 * DAY_MS;
/** Reviews of one photo, per account. */
export const REVIEWS_PER_PHOTO = 3;

/** Usage rows of an account in a month (`YYYY-MM`) or a day (`YYYY-MM-DD`), the plan's only or all. */
function countUsage(
  db: Db,
  accountId: string,
  period: 'month' | 'day',
  value: string,
  planOnly: boolean,
): number {
  // `period` is one of two literals, never user input.
  const sql = `SELECT COUNT(*) AS n FROM usage WHERE account_id = ? AND ${period} = ?${
    planOnly ? " AND kind = 'plan'" : ''
  }`;
  return (db.prepare(sql).get(accountId, value) as { n: number }).n;
}

/**
 * Charges one analysis of `photoKey` to the account, unless it is free or over a cap. Call it
 * right before the work, and `release()` the result if the work fails: a failed search costs
 * nothing.
 */
export function reserveAnalysis(
  db: Db,
  accountId: string,
  photoKey: string,
  now: Date,
): Reservation {
  const { month, day } = periodIds(now);
  const at = now.getTime();

  const reserve = db.transaction((): Reservation => {
    // Served already this month: free. The time moves up so the review window follows the latest
    // serving, not the first.
    const again = db
      .prepare(
        'UPDATE usage SET served_at = MAX(served_at, ?) WHERE account_id = ? AND photo_key = ? AND month = ?',
      )
      .run(at, accountId, photoKey, month);
    if (again.changes > 0) return { ok: true, charged: false };

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
      Account | undefined;
    if (!account) return { ok: false, reason: 'none' };

    const rights = entitlement(account);
    if (rights.kind === 'none') {
      // The trial is the first thing an account has: with no plan ever, the trial ran out.
      const everSubscribed = account.plan !== null || account.subscription_id !== null;
      return { ok: false, reason: everSubscribed ? 'none' : 'trial' };
    }

    if (rights.kind === 'plan') {
      if (countUsage(db, accountId, 'month', month, true) >= rights.monthCap) {
        return { ok: false, reason: 'month' };
      }
      if (countUsage(db, accountId, 'day', day, true) >= rights.dayCap) {
        return { ok: false, reason: 'day' };
      }
    } else {
      const taken = db
        .prepare('UPDATE accounts SET trial_left = trial_left - 1 WHERE id = ? AND trial_left > 0')
        .run(accountId);
      if (taken.changes === 0) return { ok: false, reason: 'trial' };
    }

    db.prepare(
      'INSERT INTO usage (account_id, photo_key, month, day, kind, served_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(accountId, photoKey, month, day, rights.kind, at);

    let released = false;
    return {
      ok: true,
      charged: true,
      release: () => {
        if (released) return;
        released = true;
        undoAnalysis(db, accountId, photoKey, month);
      },
    };
  });

  return reserve.immediate();
}

/** Deletes the month's usage row and, for a trial row, gives the analysis back. */
function undoAnalysis(db: Db, accountId: string, photoKey: string, month: string): boolean {
  return db
    .transaction(() => {
      const row = db
        .prepare(
          'DELETE FROM usage WHERE account_id = ? AND photo_key = ? AND month = ? RETURNING kind',
        )
        .get(accountId, photoKey, month) as { kind: string } | undefined;
      if (!row) return false;
      if (row.kind === 'trial') {
        db.prepare('UPDATE accounts SET trial_left = MIN(trial_left + 1, ?) WHERE id = ?').run(
          TRIAL_ANALYSES,
          accountId,
        );
      }
      return true;
    })
    .immediate();
}

/**
 * Undoes the reservation of this photo in the month of `now`: the usage row goes and a trial unit
 * comes back. Only for a reservation that was `charged` (a free one has nothing to undo, and this
 * would delete the earlier charge): `Reservation.release` is the safer way, it remembers the
 * month and works once. Returns whether a row was undone.
 */
export function releaseAnalysis(db: Db, accountId: string, photoKey: string, now: Date): boolean {
  return undoAnalysis(db, accountId, photoKey, periodIds(now).month);
}

/**
 * Whether the account may run an AI review of this photo: it was served to it in the last 7 days
 * and fewer than 3 reviews were made for it. Counts the review when it answers true: call
 * `releaseReview` if the review then fails.
 */
export function allowReview(db: Db, accountId: string, photoKey: string, now: Date): boolean {
  const at = now.getTime();
  return db
    .transaction((): boolean => {
      const served = db
        .prepare('SELECT MAX(served_at) AS at FROM usage WHERE account_id = ? AND photo_key = ?')
        .get(accountId, photoKey) as { at: number | null };
      if (served.at === null || at - served.at > REVIEW_WINDOW_MS) return false;

      const done = db
        .prepare('SELECT count FROM reviews WHERE account_id = ? AND photo_key = ?')
        .get(accountId, photoKey) as { count: number } | undefined;
      if (done && done.count >= REVIEWS_PER_PHOTO) return false;

      db.prepare(
        `INSERT INTO reviews (account_id, photo_key, count, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (account_id, photo_key) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      ).run(accountId, photoKey, at);
      return true;
    })
    .immediate();
}

/** Gives back the review `allowReview` counted, once, when the review itself failed. */
export function releaseReview(db: Db, accountId: string, photoKey: string): void {
  db.prepare(
    'UPDATE reviews SET count = MAX(count - 1, 0) WHERE account_id = ? AND photo_key = ?',
  ).run(accountId, photoKey);
}

/** A counter and its cap; `cap` is null when the account has none (the trial has no daily cap). */
export interface Window {
  used: number;
  cap: number | null;
}

/** What `/v1/me` shows. */
export interface UsageSummary {
  kind: Entitlement['kind'];
  /** Only for `kind: 'plan'`. */
  plan?: PlanName;
  month: Window;
  day: Window;
  /** Analyses left of the free trial (0 once it is used up, kept while a plan is active). */
  trialLeft: number;
}

/**
 * The counters of the current month and day. With a plan, they count the plan's analyses against
 * its caps; without one there is no cap to show, so they just count every analysis served.
 */
export function usageSummary(db: Db, account: Account, now: Date): UsageSummary {
  const { month, day } = periodIds(now);
  const rights = entitlement(account);
  const planOnly = rights.kind === 'plan';
  return {
    kind: rights.kind,
    ...(rights.kind === 'plan' && { plan: rights.plan }),
    month: {
      used: countUsage(db, account.id, 'month', month, planOnly),
      cap: rights.kind === 'plan' ? rights.monthCap : null,
    },
    day: {
      used: countUsage(db, account.id, 'day', day, planOnly),
      cap: rights.kind === 'plan' ? rights.dayCap : null,
    },
    trialLeft: account.trial_left,
  };
}

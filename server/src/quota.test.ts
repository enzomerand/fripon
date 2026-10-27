import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccount, openDb, type Db } from './db';
import {
  REVIEWS_PER_PHOTO,
  REVIEW_WINDOW_MS,
  allowReview,
  mayReview,
  releaseAnalysis,
  releaseReview,
  reserveAnalysis,
  usageSummary,
  type Reservation,
} from './quota';
import { fakeClock, insertAccount, insertSubscriber, type Clock } from './test-helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

let db: Db;
let clock: Clock;

beforeEach(() => {
  db = openDb(':memory:');
  // 14:00 in Paris on 20 October 2026.
  clock = fakeClock('2026-10-20T12:00:00Z');
});

afterEach(() => db.close());

const photo = (n: number) => `https://images1.vinted.net/t/01_${n}/f800.webp`;

const reserve = (accountId: string, key = photo(1)) =>
  reserveAnalysis(db, accountId, key, clock.now());

/** The reservation of a charged analysis; fails the test when it is anything else. */
function charged(reservation: Reservation) {
  if (!reservation.ok || !reservation.charged) throw new Error('expected a charged analysis');
  return reservation;
}

const rows = (accountId: string) =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM usage WHERE account_id = ?').get(accountId) as {
      n: number;
    }
  ).n;

const trialLeft = (accountId: string) => getAccount(db, accountId)?.trial_left;

/** Fills a month with `count` plan analyses spread over days that are not today. */
function seedMonth(accountId: string, count: number, month = '2026-10', perDay = 20) {
  const insert = db.prepare(
    `INSERT INTO usage (account_id, photo_key, month, day, kind, served_at)
     VALUES (?, ?, ?, ?, 'plan', ?)`,
  );
  for (let i = 0; i < count; i++) {
    const day = `${month}-${String(1 + Math.floor(i / perDay)).padStart(2, '0')}`;
    insert.run(accountId, `seed-${month}-${i}`, month, day, 0);
  }
}

/** Fills today with `count` plan analyses. */
function seedToday(accountId: string, count: number) {
  const insert = db.prepare(
    `INSERT INTO usage (account_id, photo_key, month, day, kind, served_at)
     VALUES (?, ?, '2026-10', '2026-10-20', 'plan', ?)`,
  );
  for (let i = 0; i < count; i++) insert.run(accountId, `today-${i}`, 0);
}

describe('reserveAnalysis: what counts', () => {
  it('charges the first analysis of a photo', () => {
    const { id } = insertSubscriber(db);
    const reservation = reserve(id);
    expect(reservation).toMatchObject({ ok: true, charged: true });
    expect(rows(id)).toBe(1);
  });

  it('serves the same photo again the same month for free, with nothing to undo', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));

    clock.advance(10 * DAY_MS);
    const again = reserve(id);
    expect(again).toEqual({ ok: true, charged: false });
    expect(rows(id)).toBe(1);
    expect(usageSummary(db, getAccount(db, id)!, clock.now()).month.used).toBe(1);
  });

  it('is free for a photo already served even once the plan is gone', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    db.prepare("UPDATE accounts SET subscription_status = 'canceled', trial_left = 0").run();
    expect(reserve(id)).toEqual({ ok: true, charged: false });
    // ...but a new photo is not.
    expect(reserve(id, photo(2))).toEqual({ ok: false, reason: 'none' });
  });

  it('charges the same photo again in a new month, at Paris midnight', () => {
    const { id } = insertSubscriber(db);
    clock.set('2026-10-31T22:59:59Z'); // 23:59:59 in Paris, 31 October
    charged(reserve(id));
    clock.set('2026-10-31T22:59:59.500Z');
    expect(reserve(id)).toEqual({ ok: true, charged: false });
    clock.set('2026-10-31T23:00:00Z'); // 00:00 in Paris, 1 November
    charged(reserve(id));
    expect(rows(id)).toBe(2);
  });

  it('counts each account on its own', () => {
    const a = insertSubscriber(db);
    const b = insertSubscriber(db);
    charged(reserve(a.id));
    charged(reserve(b.id));
    expect(rows(a.id)).toBe(1);
    expect(rows(b.id)).toBe(1);
  });

  it('refuses an account that does not exist', () => {
    expect(reserve('nobody')).toEqual({ ok: false, reason: 'none' });
  });

  it('moves the served time of a free re-serve forward, never back', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    clock.advance(3 * DAY_MS);
    reserve(id);
    const served = () =>
      (
        db.prepare('SELECT served_at FROM usage WHERE account_id = ?').get(id) as {
          served_at: number;
        }
      ).served_at;
    expect(served()).toBe(clock.ms());
    clock.advance(-2 * DAY_MS);
    reserve(id);
    expect(served()).toBe(clock.ms() + 2 * DAY_MS);
  });
});

describe('reserveAnalysis: plan caps', () => {
  it('stops an Essentiel account at 40 a day, and starts again the next day', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    seedToday(id, 39);
    charged(reserve(id, photo(1))); // the 40th
    expect(reserve(id, photo(2))).toEqual({ ok: false, reason: 'day' });
    expect(rows(id)).toBe(40);

    clock.advance(DAY_MS);
    charged(reserve(id, photo(2)));
  });

  it('stops an Essentiel account at 300 a month, whatever the day', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    seedMonth(id, 299);
    charged(reserve(id, photo(1))); // the 300th
    expect(reserve(id, photo(2))).toEqual({ ok: false, reason: 'month' });

    // Still the same month the next day.
    clock.advance(DAY_MS);
    expect(reserve(id, photo(3))).toEqual({ ok: false, reason: 'month' });
  });

  it('starts again on the first of the month', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    seedMonth(id, 300);
    expect(reserve(id)).toEqual({ ok: false, reason: 'month' });
    clock.set('2026-10-31T23:00:00Z');
    charged(reserve(id));
  });

  it('gives a Revendeur account 100 a day and 1000 a month', () => {
    const { id } = insertSubscriber(db, 'revendeur');
    seedToday(id, 99);
    charged(reserve(id, photo(1)));
    expect(reserve(id, photo(2))).toEqual({ ok: false, reason: 'day' });

    const other = insertSubscriber(db, 'revendeur');
    seedMonth(other.id, 999, '2026-10', 50);
    charged(reserve(other.id, photo(1)));
    expect(reserve(other.id, photo(2))).toEqual({ ok: false, reason: 'month' });
  });

  it('says month when both caps are reached', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    seedMonth(id, 260);
    seedToday(id, 40);
    expect(reserve(id)).toEqual({ ok: false, reason: 'month' });
  });

  it('keeps the plan while a payment is late (past_due)', () => {
    const { id } = insertSubscriber(db, 'essentiel', { subscription_status: 'past_due' });
    charged(reserve(id));
  });

  it('does not count trial analyses against the plan', () => {
    const { id } = insertAccount(db);
    for (let i = 0; i < 5; i++) charged(reserve(id, photo(i)));
    db.prepare("UPDATE accounts SET plan = 'essentiel', subscription_status = 'active'").run();

    const summary = usageSummary(db, getAccount(db, id)!, clock.now());
    expect(summary.month).toEqual({ used: 0, cap: 300 });
    seedToday(id, 39);
    charged(reserve(id, photo(10))); // the 40th plan analysis of the day, not the 45th
  });
});

describe('reserveAnalysis: an active status nobody renewed', () => {
  it('keeps the plan inside the 3-day grace after the period end, then falls back to the trial', () => {
    const { id } = insertSubscriber(db, 'essentiel', { period_end: clock.ms() - 2 * DAY_MS });
    const first = charged(reserve(id, photo(1)));
    expect(first.ok).toBe(true);
    expect(db.prepare('SELECT kind FROM usage WHERE account_id = ?').get(id)).toEqual({
      kind: 'plan',
    });
    expect(trialLeft(id)).toBe(15);

    // The lost renewal event is now more than 3 days old: the quota stops, the trial takes over.
    clock.advance(2 * DAY_MS);
    charged(reserve(id, photo(2)));
    expect(trialLeft(id)).toBe(14);
    expect(usageSummary(db, getAccount(db, id)!, clock.now())).toMatchObject({ kind: 'trial' });
  });

  it('refuses once the trial is used up too, as for any account without a subscription', () => {
    const { id } = insertSubscriber(db, 'essentiel', {
      period_end: clock.ms() - 4 * DAY_MS,
      trial_left: 0,
    });
    // It subscribed once, so the reason is "none", not "trial".
    expect(reserve(id)).toEqual({ ok: false, reason: 'none' });
  });

  it('lets a renewal (a later period end) bring the plan back', () => {
    const { id } = insertSubscriber(db, 'essentiel', { period_end: clock.ms() - 10 * DAY_MS });
    expect(usageSummary(db, getAccount(db, id)!, clock.now())).toMatchObject({ kind: 'trial' });
    db.prepare('UPDATE accounts SET period_end = ? WHERE id = ?').run(clock.ms() + 20 * DAY_MS, id);
    expect(usageSummary(db, getAccount(db, id)!, clock.now())).toMatchObject({
      kind: 'plan',
      plan: 'essentiel',
    });
  });
});

describe('reserveAnalysis: the free trial', () => {
  it('takes one trial analysis per new photo, 15 in all', () => {
    const { id } = insertAccount(db);
    for (let i = 1; i <= 15; i++) {
      charged(reserve(id, photo(i)));
      expect(trialLeft(id)).toBe(15 - i);
    }
    expect(reserve(id, photo(16))).toEqual({ ok: false, reason: 'trial' });
    expect(rows(id)).toBe(15);
    expect(trialLeft(id)).toBe(0);
  });

  it('has no daily cap: the 15 can go in one day', () => {
    const { id } = insertAccount(db);
    for (let i = 1; i <= 15; i++) charged(reserve(id, photo(i)));
    const kinds = db.prepare('SELECT DISTINCT kind, day FROM usage').all();
    expect(kinds).toEqual([{ kind: 'trial', day: '2026-10-20' }]);
  });

  it('does not charge the trial again for a photo already served', () => {
    const { id } = insertAccount(db);
    charged(reserve(id));
    expect(reserve(id)).toEqual({ ok: true, charged: false });
    expect(trialLeft(id)).toBe(14);
  });

  it('says trial when it is used up and the account never subscribed', () => {
    const { id } = insertAccount(db, { trial_left: 0 });
    expect(reserve(id)).toEqual({ ok: false, reason: 'trial' });
  });

  it('says none when the subscription ended and the trial is used up', () => {
    const { id } = insertAccount(db, {
      trial_left: 0,
      plan: 'essentiel',
      subscription_id: 'sub_1',
      subscription_status: 'canceled',
    });
    expect(reserve(id)).toEqual({ ok: false, reason: 'none' });
  });

  it('falls back to the trial that is left when a subscription ends', () => {
    const { id } = insertSubscriber(db, 'essentiel', { trial_left: 7 });
    db.prepare("UPDATE accounts SET subscription_status = 'canceled'").run();
    charged(reserve(id));
    expect(trialLeft(id)).toBe(6);
  });

  it('leaves the trial alone while a plan pays', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    charged(reserve(id));
    expect(trialLeft(id)).toBe(15);
  });
});

describe('release: a failed analysis costs nothing', () => {
  it('gives a plan analysis back', () => {
    const { id } = insertSubscriber(db);
    seedToday(id, 39);
    const reservation = charged(reserve(id));
    expect(reserve(id, photo(2))).toEqual({ ok: false, reason: 'day' });

    reservation.release();
    expect(rows(id)).toBe(39);
    charged(reserve(id, photo(2)));
  });

  it('gives a trial analysis back', () => {
    const { id } = insertAccount(db);
    const reservation = charged(reserve(id));
    expect(trialLeft(id)).toBe(14);
    reservation.release();
    expect(trialLeft(id)).toBe(15);
    expect(rows(id)).toBe(0);
  });

  it('works once: a second release changes nothing', () => {
    const { id } = insertAccount(db);
    const first = charged(reserve(id));
    first.release();
    const second = charged(reserve(id)); // the same photo, charged again
    first.release();
    first.release();
    expect(rows(id)).toBe(1);
    expect(trialLeft(id)).toBe(14);
    second.release();
    expect(trialLeft(id)).toBe(15);
  });

  it('releases the month it was charged in, even after midnight', () => {
    const { id } = insertSubscriber(db);
    clock.set('2026-10-31T22:59:59Z');
    const reservation = charged(reserve(id));
    clock.set('2026-10-31T23:00:05Z'); // November now
    reservation.release();
    expect(rows(id)).toBe(0);
  });

  it('never gives back more than the 15 of the trial', () => {
    const { id } = insertAccount(db);
    charged(reserve(id));
    db.prepare('UPDATE accounts SET trial_left = 15').run();
    releaseAnalysis(db, id, photo(1), clock.now());
    expect(trialLeft(id)).toBe(15);
  });

  it('releaseAnalysis undoes the reservation of the month of `now`', () => {
    const { id } = insertAccount(db);
    charged(reserve(id));
    expect(releaseAnalysis(db, id, photo(1), clock.now())).toBe(true);
    expect(releaseAnalysis(db, id, photo(1), clock.now())).toBe(false);
    expect(trialLeft(id)).toBe(15);
  });

  it('only undoes its own photo', () => {
    const { id } = insertAccount(db);
    charged(reserve(id, photo(1)));
    const second = charged(reserve(id, photo(2)));
    second.release();
    expect(rows(id)).toBe(1);
    expect(trialLeft(id)).toBe(14);
  });
});

describe('reserveAnalysis: concurrent reservations cannot pass a cap', () => {
  it('lets one of two reservations through at cap - 1 (same connection)', async () => {
    const { id } = insertSubscriber(db);
    seedToday(id, 39);
    const results = await Promise.all([
      Promise.resolve().then(() => reserve(id, photo(1))),
      Promise.resolve().then(() => reserve(id, photo(2))),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'day' }]);
    expect(rows(id)).toBe(40);
  });

  it('holds across two connections to the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fripon-quota-'));
    const path = join(dir, 'test.db');
    const first = openDb(path);
    const second = openDb(path);
    try {
      const { id } = insertSubscriber(first);
      const insert = first.prepare(
        `INSERT INTO usage (account_id, photo_key, month, day, kind, served_at)
         VALUES (?, ?, '2026-10', '2026-10-20', 'plan', 0)`,
      );
      for (let i = 0; i < 39; i++) insert.run(id, `seed-${i}`);

      const now = clock.now();
      const results = [
        reserveAnalysis(first, id, photo(1), now),
        reserveAnalysis(second, id, photo(2), now),
        reserveAnalysis(first, id, photo(3), now),
        reserveAnalysis(second, id, photo(4), now),
      ];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((first.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(40);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a trial analysis to one of two reservations when only one is left', () => {
    const { id } = insertAccount(db, { trial_left: 1 });
    const results = [reserve(id, photo(1)), reserve(id, photo(2))];
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(trialLeft(id)).toBe(0);
  });
});

describe('allowReview', () => {
  const allow = (accountId: string, key = photo(1)) => allowReview(db, accountId, key, clock.now());

  it('refuses a photo that was never served to the account', () => {
    const { id } = insertSubscriber(db);
    expect(allow(id)).toBe(false);
    const reviews = db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as { n: number };
    expect(reviews.n).toBe(0);
  });

  it('refuses a photo that was served to somebody else', () => {
    const a = insertSubscriber(db);
    const b = insertSubscriber(db);
    charged(reserve(a.id));
    expect(allow(b.id)).toBe(false);
  });

  it('allows a photo served to the account, 3 times, then no more', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    for (let i = 0; i < REVIEWS_PER_PHOTO; i++) expect(allow(id)).toBe(true);
    expect(allow(id)).toBe(false);
    expect(allow(id)).toBe(false);
    // Another photo of the same account has its own 3.
    charged(reserve(id, photo(2)));
    expect(allow(id, photo(2))).toBe(true);
  });

  it('allows it up to 7 days after the search, not a millisecond more', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    clock.advance(REVIEW_WINDOW_MS);
    expect(allow(id)).toBe(true);
    clock.advance(1);
    // The window runs from the search, not from the last review.
    expect(allow(id)).toBe(false);
  });

  it('is open again 7 days after the photo is served again', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    clock.advance(6 * DAY_MS);
    reserve(id); // free re-serve
    clock.advance(6 * DAY_MS);
    expect(allow(id)).toBe(true);
  });

  it('does not allow a review of a search that was released', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id)).release();
    expect(allow(id)).toBe(false);
  });

  it('counts atomically across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fripon-review-'));
    const path = join(dir, 'test.db');
    const first = openDb(path);
    const second = openDb(path);
    try {
      const { id } = insertSubscriber(first);
      charged(reserveAnalysis(first, id, photo(1), clock.now()));
      const answers = [first, second, first, second, first].map((connection) =>
        allowReview(connection, id, photo(1), clock.now()),
      );
      expect(answers).toEqual([true, true, true, false, false]);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives a review back when it failed', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    for (let i = 0; i < 3; i++) allow(id);
    expect(allow(id)).toBe(false);
    releaseReview(db, id, photo(1), clock.now());
    expect(allow(id)).toBe(true);
    expect(allow(id)).toBe(false);
  });

  it('never goes below zero when released too often', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    allow(id);
    releaseReview(db, id, photo(1), clock.now());
    releaseReview(db, id, photo(1), clock.now());
    releaseReview(db, id, 'unknown-photo', clock.now());
    const row = db.prepare('SELECT count FROM reviews').get() as { count: number };
    expect(row.count).toBe(0);
  });
});

describe('reviews counted per month, for the calls that really go to Gemini', () => {
  const allow = (accountId: string, key = photo(1)) => allowReview(db, accountId, key, clock.now());
  const counted = (accountId: string) =>
    (
      db
        .prepare('SELECT month, count FROM reviews WHERE account_id = ? ORDER BY month')
        .all(accountId) as { month: string; count: number }[]
    ).map((row) => `${row.month}:${row.count}`);

  it('mayReview only reads: a photo served this week may be reviewed, nothing is counted', () => {
    const { id } = insertSubscriber(db);
    expect(mayReview(db, id, photo(1), clock.now())).toBe(false);
    charged(reserve(id));
    expect(mayReview(db, id, photo(1), clock.now())).toBe(true);
    expect(mayReview(db, id, photo(1), clock.now())).toBe(true);
    expect(counted(id)).toEqual([]);
    clock.advance(REVIEW_WINDOW_MS);
    expect(mayReview(db, id, photo(1), clock.now())).toBe(true);
    clock.advance(1);
    expect(mayReview(db, id, photo(1), clock.now())).toBe(false);
  });

  it('gives 3 more reviews of the photo in the next Paris month', () => {
    const { id } = insertSubscriber(db);
    clock.set('2026-10-30T12:00:00Z');
    charged(reserve(id));
    for (let i = 0; i < REVIEWS_PER_PHOTO; i++) expect(allow(id)).toBe(true);
    expect(allow(id)).toBe(false);

    // 1 November, 13:00 in Paris: a new month for the counter (the search is still 2 days old).
    clock.set('2026-11-01T12:00:00Z');
    expect(allow(id)).toBe(true);
    expect(counted(id)).toEqual(['2026-10:3', '2026-11:1']);
  });

  it('counts the month in Paris, not in UTC', () => {
    const { id } = insertSubscriber(db);
    clock.set('2026-10-31T22:30:00Z'); // 23:30 in Paris on the 31st
    charged(reserve(id));
    allow(id);
    clock.set('2026-10-31T23:30:00Z'); // 00:30 in Paris on 1 November
    allow(id);
    expect(counted(id)).toEqual(['2026-10:1', '2026-11:1']);
  });

  it('gives a review back in the month it was counted in', () => {
    const { id } = insertSubscriber(db);
    clock.set('2026-10-31T12:00:00Z');
    charged(reserve(id));
    const countedAt = clock.now();
    allow(id);
    clock.set('2026-11-01T12:00:00Z');

    releaseReview(db, id, photo(1), countedAt);

    expect(counted(id)).toEqual(['2026-10:0']);
  });
});

describe('usageSummary', () => {
  const summary = (accountId: string) => usageSummary(db, getAccount(db, accountId)!, clock.now());

  it('shows the plan with its caps and what is used', () => {
    const { id } = insertSubscriber(db, 'essentiel');
    seedMonth(id, 30);
    charged(reserve(id));
    charged(reserve(id, photo(2)));
    expect(summary(id)).toEqual({
      kind: 'plan',
      plan: 'essentiel',
      month: { used: 32, cap: 300 },
      day: { used: 2, cap: 40 },
      trialLeft: 15,
    });
  });

  it('shows the Revendeur caps', () => {
    const { id } = insertSubscriber(db, 'revendeur');
    expect(summary(id)).toMatchObject({
      plan: 'revendeur',
      month: { used: 0, cap: 1000 },
      day: { used: 0, cap: 100 },
    });
  });

  it('shows the trial without caps', () => {
    const { id } = insertAccount(db);
    charged(reserve(id));
    expect(summary(id)).toEqual({
      kind: 'trial',
      month: { used: 1, cap: null },
      day: { used: 1, cap: null },
      trialLeft: 14,
    });
  });

  it('shows nothing left when there is nothing', () => {
    const { id } = insertAccount(db, { trial_left: 0 });
    expect(summary(id)).toEqual({
      kind: 'none',
      month: { used: 0, cap: null },
      day: { used: 0, cap: null },
      trialLeft: 0,
    });
  });

  it('counts today and this month only', () => {
    const { id } = insertSubscriber(db);
    charged(reserve(id));
    clock.advance(DAY_MS);
    expect(summary(id)).toMatchObject({ month: { used: 1 }, day: { used: 0 } });
    clock.set('2026-11-02T12:00:00Z');
    expect(summary(id)).toMatchObject({ month: { used: 0 }, day: { used: 0 } });
  });
});

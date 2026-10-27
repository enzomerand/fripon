import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db';
import { createSharedCache } from './shared-cache';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => db.close());

const asList = (raw: unknown) => (Array.isArray(raw) ? (raw as string[]) : null);

describe('createSharedCache', () => {
  it('stores a value and reads it back until it expires', () => {
    const cache = createSharedCache(db);
    cache.set('k', ['a', 'b'], 1_000, 500);
    expect(cache.get('k', 1_000, asList)).toEqual(['a', 'b']);
    expect(cache.get('k', 1_499, asList)).toEqual(['a', 'b']);
    expect(cache.get('k', 1_500, asList)).toBeNull();
  });

  it('is empty for a key nobody wrote', () => {
    expect(createSharedCache(db).get('nope', 0, asList)).toBeNull();
  });

  it('replaces an earlier value and its expiry', () => {
    const cache = createSharedCache(db);
    cache.set('k', ['old'], 0, 100);
    cache.set('k', ['new'], 50, 100);
    expect(cache.get('k', 120, asList)).toEqual(['new']);
  });

  it('keeps an empty list: "found nothing" is an answer worth keeping', () => {
    const cache = createSharedCache(db);
    cache.set('k', [], 0, 100);
    expect(cache.get('k', 1, asList)).toEqual([]);
  });

  it('reads what the caller refuses, and a damaged row, as a miss', () => {
    const cache = createSharedCache(db);
    cache.set('k', { not: 'a list' }, 0, 100);
    expect(cache.get('k', 1, asList)).toBeNull();

    db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)').run(
      'bad',
      '{oops',
      100,
    );
    expect(cache.get('bad', 1, asList)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLock } from './lock';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Two tasks that each log "start" and "end" around a pause: overlapping would interleave them. */
function pausingTasks(log: string[]) {
  const task = (label: string) => async () => {
    log.push(`${label}:start`);
    await sleep(10);
    log.push(`${label}:end`);
    return label;
  };
  return task;
}

describe('withLock (no Web Locks)', () => {
  it('runs the tasks of one name one after the other, in order', async () => {
    const log: string[] = [];
    const task = pausingTasks(log);
    const results = await Promise.all([
      withLock('a', task('1')),
      withLock('a', task('2')),
      withLock('a', task('3')),
    ]);
    expect(results).toEqual(['1', '2', '3']);
    expect(log).toEqual(['1:start', '1:end', '2:start', '2:end', '3:start', '3:end']);
  });

  it('lets different names run side by side', async () => {
    const log: string[] = [];
    const task = pausingTasks(log);
    await Promise.all([withLock('a', task('1')), withLock('b', task('2'))]);
    expect(log.slice(0, 2)).toEqual(['1:start', '2:start']);
  });

  it('hands a failure to its caller and keeps the queue going', async () => {
    const failing = withLock('a', () => Promise.reject(new Error('boom')));
    const next = withLock('a', () => Promise.resolve('fine'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('fine');
  });
});

describe('withLock (Web Locks)', () => {
  function stubLocks() {
    // A minimal lock manager: exclusive per name, like the real one.
    const tails = new Map<string, Promise<unknown>>();
    const request = vi.fn(<T>(name: string, callback: () => Promise<T>): Promise<T> => {
      const run = (tails.get(name) ?? Promise.resolve()).then(callback);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    return request;
  }

  it('asks navigator.locks for the named lock and returns the task result', async () => {
    const request = stubLocks();
    await expect(withLock('fripon:credits', () => Promise.resolve(42))).resolves.toBe(42);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe('fripon:credits');
  });

  it('passes a failure through', async () => {
    stubLocks();
    await expect(withLock('x', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
  });

  it('serialises through the lock manager', async () => {
    stubLocks();
    const log: string[] = [];
    const task = pausingTasks(log);
    await Promise.all([withLock('a', task('1')), withLock('a', task('2'))]);
    expect(log).toEqual(['1:start', '1:end', '2:start', '2:end']);
  });

  it('falls back to the in-module chain when the lock manager is missing', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    await expect(withLock('a', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

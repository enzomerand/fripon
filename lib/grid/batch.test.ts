import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_SPACING_MS,
  MAX_CONSECUTIVE_FAILURES,
  createBatch,
  type AnalyzeResult,
  type BatchDeps,
} from './batch';

const IDS = ['9000101', '9000102', '9000103', '9000104'];

/** The next result of each call to `analyze`; once it runs out, every card is done. */
function setup(results: Array<AnalyzeResult | Error> = [], remaining: number | null = 40) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let running = 0;
  let maxRunning = 0;
  const queue = [...results];
  const deps: BatchDeps = {
    analyze: async (id) => {
      calls.push(id);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running--;
      const next = queue.shift() ?? 'done';
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    remaining: () => Promise.resolve(remaining),
  };
  return { deps, calls, sleeps, maxRunning: () => maxRunning };
}

describe('asking', () => {
  it('waits for a confirmation, with the credits it may cost and those that are left', async () => {
    const { deps, calls } = setup([], 37);
    const batch = createBatch(deps);
    const listener = vi.fn();
    batch.subscribe(listener);

    await batch.ask(IDS);

    expect(batch.state()).toEqual({ phase: 'confirm', total: 4, remaining: 37 });
    expect(listener).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });

  it('does not know the credits left without a cap', async () => {
    const batch = createBatch(setup([], null).deps);
    await batch.ask(IDS);
    expect(batch.state()).toEqual({ phase: 'confirm', total: 4, remaining: null });
  });

  it('asks all the same when the credits cannot be read', async () => {
    const { deps } = setup();
    const batch = createBatch({ ...deps, remaining: () => Promise.reject(new Error('closed')) });
    await batch.ask(IDS);
    expect(batch.state()).toEqual({ phase: 'confirm', total: 4, remaining: null });
  });

  it('has nothing to ask about no card', async () => {
    const batch = createBatch(setup().deps);
    await batch.ask([]);
    expect(batch.state()).toEqual({ phase: 'idle', last: null });
  });

  it('asks once for a double click, and not again while it waits', async () => {
    const { deps } = setup();
    const remaining = vi.fn(deps.remaining);
    const batch = createBatch({ ...deps, remaining });
    await Promise.all([batch.ask(IDS), batch.ask(IDS)]);
    await batch.ask(['9000199']);
    expect(remaining).toHaveBeenCalledOnce();
    expect(batch.state()).toMatchObject({ phase: 'confirm', total: 4 });
  });

  it('starts nothing when cancelled', async () => {
    const { deps, calls } = setup();
    const batch = createBatch(deps);
    await batch.ask(IDS);
    batch.cancel();
    expect(batch.state()).toEqual({ phase: 'idle', last: null });
    await batch.launch();
    expect(calls).toEqual([]);
  });

  it('does not launch without a confirmation', async () => {
    const { deps, calls } = setup();
    const batch = createBatch(deps);
    await batch.launch();
    expect(calls).toEqual([]);
  });
});

describe('running', () => {
  it('goes through the cards one at a time, in order', async () => {
    const { deps, calls, maxRunning } = setup();
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(calls).toEqual(IDS);
    expect(maxRunning()).toBe(1);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'finished', analysed: 4 } });
  });

  it('waits a second between two analyses, and not after the last one', async () => {
    const { deps, sleeps } = setup();
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(BATCH_SPACING_MS).toBe(1_000);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it('does not wait for a card that had nothing to do', async () => {
    const { deps, sleeps } = setup(['skipped', 'done', 'skipped', 'done']);
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(sleeps).toEqual([1_000]);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'finished', analysed: 2 } });
  });

  it('shows how far it got', async () => {
    const { deps } = setup();
    const batch = createBatch(deps);
    const positions: number[] = [];
    batch.subscribe(() => {
      const state = batch.state();
      if (state.phase === 'running') positions.push(state.position);
    });
    await batch.ask(IDS);
    await batch.launch();
    expect(positions).toEqual([0, 1, 2, 3]);
  });

  it('stops at the cap: the cards that remain are not tried', async () => {
    const { deps, calls } = setup(['done', 'quota']);
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(calls).toEqual(['9000101', '9000102']);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'quota', analysed: 2 } });
  });

  it('stops when there is no key', async () => {
    const { deps, calls } = setup(['needsKey']);
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(calls).toEqual(['9000101']);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'needsKey', analysed: 1 } });
  });

  it('goes on after a failure, and gives up after several in a row', async () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
    const lone = setup(['error', 'done', 'error', 'done']);
    const first = createBatch(lone.deps);
    await first.ask(IDS);
    await first.launch();
    expect(lone.calls).toEqual(IDS);

    const down = setup(['error', 'error', 'error', 'done']);
    const second = createBatch(down.deps);
    await second.ask(IDS);
    await second.launch();
    expect(down.calls).toEqual(['9000101', '9000102', '9000103']);
    expect(second.state()).toEqual({ phase: 'idle', last: { reason: 'failures', analysed: 3 } });
  });

  it('counts a success as the end of a series of failures', async () => {
    const { deps, calls } = setup(['error', 'error', 'done', 'error']);
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(calls).toEqual(IDS);
  });

  it('counts an analysis that rejects as a failure', async () => {
    const { deps, calls } = setup([new Error('boom'), 'done']);
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(calls).toEqual(IDS);
  });

  it('forgets how the last batch ended once a new one is asked', async () => {
    const batch = createBatch(setup().deps);
    await batch.ask(IDS);
    await batch.launch();
    expect(batch.state()).toMatchObject({ phase: 'idle', last: { reason: 'finished' } });
    await batch.ask(IDS);
    expect(batch.state()).toMatchObject({ phase: 'confirm' });
    batch.cancel();
    expect(batch.state()).toEqual({ phase: 'idle', last: null });
  });

  it('cannot be launched twice at once', async () => {
    const { deps, calls } = setup();
    const batch = createBatch(deps);
    await batch.ask(IDS);
    await Promise.all([batch.launch(), batch.launch()]);
    expect(calls).toEqual(IDS);
  });
});

describe('stopping', () => {
  it('lets the card being analysed finish and starts no other', async () => {
    let finish: (result: AnalyzeResult) => void = () => undefined;
    const calls: string[] = [];
    const batch = createBatch({
      analyze: (id) => {
        calls.push(id);
        return new Promise((resolve) => (finish = resolve));
      },
      sleep: () => Promise.resolve(),
      remaining: () => Promise.resolve(null),
    });
    await batch.ask(IDS);
    const launched = batch.launch();
    await Promise.resolve();

    batch.stop();
    expect(batch.state()).toMatchObject({ phase: 'running', stopping: true });
    finish('done');
    await launched;

    expect(calls).toEqual(['9000101']);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'stopped', analysed: 1 } });
  });

  it('does not wait for the pause between two cards', async () => {
    const calls: string[] = [];
    const batch = createBatch({
      analyze: (id) => {
        calls.push(id);
        return Promise.resolve('done');
      },
      // A pause that never ends: only the stop can end it.
      sleep: () => new Promise(() => undefined),
      remaining: () => Promise.resolve(null),
    });
    await batch.ask(IDS);
    const launched = batch.launch();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(['9000101']);

    batch.stop();
    await launched;

    expect(calls).toEqual(['9000101']);
    expect(batch.state()).toEqual({ phase: 'idle', last: { reason: 'stopped', analysed: 1 } });
  });

  it('does nothing when no batch is running', async () => {
    const batch = createBatch(setup().deps);
    batch.stop();
    expect(batch.state()).toEqual({ phase: 'idle', last: null });
    await batch.ask(IDS);
    batch.stop();
    expect(batch.state()).toMatchObject({ phase: 'confirm' });
  });
});

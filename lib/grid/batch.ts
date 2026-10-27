import type { QuickOutcome } from './quick-analysis';

/** Pause between two cards of a batch: the cards are searched one by one, never in a burst. */
export const BATCH_SPACING_MS = 1_000;
/** A batch gives up after this many failures in a row (Google or the network is down). */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How the analysis of one card ended: its outcome, or `skipped` when there was nothing to do.
 * `noPhoto` is an outcome in which nothing was sent either.
 */
export type AnalyzeResult = QuickOutcome['status'] | 'skipped';

/** Everything a batch needs from the page, injected so it can be tested. */
export interface BatchDeps {
  /** Analyses the card of this item. Never rejects (a rejection counts as a failure). */
  analyze(id: string): Promise<AnalyzeResult>;
  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void>;
  /** Vision credits left, null without a cap or when unknown. */
  remaining(): Promise<number | null>;
}

/**
 * finished: every card was gone through. stopped: the user pressed "Arrêter". quota: the cap was
 * reached, the cards that remain were not tried. needsKey: no key, or a refused one. failures: too
 * many searches failed in a row.
 */
export type StopReason = 'finished' | 'stopped' | 'quota' | 'needsKey' | 'failures';

export interface BatchEnd {
  reason: StopReason;
  /** Cards whose search really ran (a verdict or a failure): skipped cards, cards without a photo and cards refused for the cap or the key do not count. */
  analysed: number;
}

export type BatchState =
  /** `last`: how the previous batch of this page ended, null before any (and once a new one is asked). */
  | { phase: 'idle'; last: BatchEnd | null }
  /** The click is taken and the credits left are being asked: the bar is already busy, not idle. */
  | { phase: 'asking' }
  /** Waiting for the user to confirm: up to `total` credits, `remaining` of them left (null: unknown). */
  | { phase: 'confirm'; total: number; remaining: number | null }
  /** `position` cards of `total` gone through. */
  | { phase: 'running'; total: number; position: number; stopping: boolean };

export interface Batch {
  state(): BatchState;
  subscribe(listener: () => void): () => void;
  /**
   * idle -> asking -> confirm: takes the cards at once (the phase is no longer idle when this
   * returns control, before anything is awaited), asks how many credits are left, then waits for
   * `launch` or `cancel`.
   */
  ask(ids: readonly string[]): Promise<void>;
  /** asking or confirm -> idle, nothing was started. */
  cancel(): void;
  /** confirm -> running -> idle. Resolves once the batch has ended. A call in any other phase does nothing. */
  launch(): Promise<void>;
  /** running -> stopping: the card being analysed finishes, no other one starts. */
  stop(): void;
}

/**
 * The analysis of several cards in a row, behind a confirmation. The cards go one at a time, in the
 * order given, with `BATCH_SPACING_MS` between two analyses (nothing is waited for a card that was
 * skipped, nor after the last one). It stops by itself when the cap is reached or the key is
 * missing, and after `MAX_CONSECUTIVE_FAILURES` failures in a row; a single failure does not stop it.
 */
export function createBatch(deps: BatchDeps): Batch {
  let state: BatchState = { phase: 'idle', last: null };
  let pending: string[] = [];
  /** Which `ask` is waiting for the credits: an answer for a cancelled one is dropped. */
  let askId = 0;
  let wake: () => void = () => undefined;
  const listeners = new Set<() => void>();

  const change = (next: BatchState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** Waits `ms`, or less if the user stops the batch in the meantime. */
  async function pause(ms: number) {
    const stopped = new Promise<void>((resolve) => {
      wake = resolve;
    });
    await Promise.race([deps.sleep(ms), stopped]);
  }

  /** The phase as it is now (after an await), not as the code above narrowed it. */
  const phaseNow = () => state.phase;
  const isStopping = () => state.phase === 'running' && state.stopping;

  async function analyse(id: string): Promise<AnalyzeResult> {
    try {
      return await deps.analyze(id);
    } catch {
      return 'error';
    }
  }

  async function run(ids: readonly string[]): Promise<BatchEnd> {
    let analysed = 0;
    let failures = 0;
    for (const [index, id] of ids.entries()) {
      if (isStopping()) return { reason: 'stopped', analysed };
      const result = await analyse(id);
      // A search really ran for a card that ended in a verdict or in a failure. Nothing was spent
      // (nor tried) for one that was skipped, has no photo, or was refused for the cap or the key:
      // no count, no pause, and no word on whether the search works.
      const sent = result === 'done' || result === 'error';
      if (sent) analysed++;
      if (result === 'quota') return { reason: 'quota', analysed };
      if (result === 'needsKey') return { reason: 'needsKey', analysed };
      if (sent) failures = result === 'error' ? failures + 1 : 0;
      if (failures >= MAX_CONSECUTIVE_FAILURES) return { reason: 'failures', analysed };
      if (index === ids.length - 1) break;
      if (isStopping()) return { reason: 'stopped', analysed };
      change({ phase: 'running', total: ids.length, position: index + 1, stopping: false });
      if (sent) await pause(BATCH_SPACING_MS);
    }
    return { reason: 'finished', analysed };
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ask(ids) {
      if (state.phase !== 'idle' || ids.length === 0) return;
      const mine = ++askId;
      pending = [...ids];
      change({ phase: 'asking' });
      const remaining = await deps.remaining().catch((): null => null);
      // Cancelled while the credits were being asked (or asked again since): nothing to confirm.
      if (phaseNow() !== 'asking' || askId !== mine) return;
      change({ phase: 'confirm', total: pending.length, remaining });
    },
    cancel() {
      if (state.phase === 'confirm' || state.phase === 'asking') {
        pending = [];
        change({ phase: 'idle', last: null });
      }
    },
    async launch() {
      if (state.phase !== 'confirm') return;
      const ids = pending;
      pending = [];
      change({ phase: 'running', total: ids.length, position: 0, stopping: false });
      const end = await run(ids);
      change({ phase: 'idle', last: end });
    },
    stop() {
      if (state.phase !== 'running' || state.stopping) return;
      change({ ...state, stopping: true });
      wake();
    },
  };
}

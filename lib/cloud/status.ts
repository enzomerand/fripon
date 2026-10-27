import type { Gate, Gates } from '../gate';
import { loadSettings, type AnalysisMode } from '../settings';
import type { CloudClient } from './client';
import { STATUS_MAX_AGE_MS } from './config';
import { loadSession, loadStatus, saveStatusFor } from './session';
import type { CloudStatus, CloudUsage } from './types';

export interface StatusKeeper {
  /**
   * The status of the signed-in account, null when signed out. It is read from the server again
   * when what is stored is older than `maxAgeMs` (a failed attempt counts as one: an account that
   * cannot be reached is not asked again on every gate). The server being out of reach keeps the
   * last snapshot. `maxAgeMs` 0 always asks.
   */
  current(maxAgeMs?: number): Promise<CloudStatus | null>;
  /**
   * The stored status when it was read less than `maxAgeMs` ago, null otherwise (or signed out).
   * Never asks the server: for the steps, which only want to know what the last reading said.
   */
  peek(maxAgeMs: number): Promise<CloudStatus | null>;
  /** Takes the usage a search answer carried: the freshest figure there is. */
  record(usage: CloudUsage): Promise<void>;
}

export interface StatusKeeperDeps {
  client: CloudClient;
  now?(): number;
}

export function createStatusKeeper(deps: StatusKeeperDeps): StatusKeeper {
  const now = deps.now ?? (() => Date.now());
  let lastAttempt = 0;
  let refreshing: Promise<CloudStatus | null> | null = null;

  /** Asks the server: the new status, null when it did not answer (signed out, or out of reach). */
  async function refresh(token: string): Promise<CloudStatus | null> {
    lastAttempt = now();
    const answer = await deps.client.me();
    if (!answer.ok) return null;
    const status: CloudStatus = { ...answer.me, checkedAt: now() };
    await saveStatusFor(token, status);
    return status;
  }

  return {
    async current(maxAgeMs = STATUS_MAX_AGE_MS) {
      const session = await loadSession();
      if (!session) return null;
      const stored = await loadStatus();
      const age = now() - Math.max(stored?.checkedAt ?? 0, lastAttempt);
      if (stored && age < maxAgeMs) return stored;

      refreshing ??= refresh(session.token).finally(() => {
        refreshing = null;
      });
      const fresh = await refreshing;
      if (fresh) return fresh;
      // Signed out meanwhile (the client cleared a refused session), or out of reach: keep the last
      // snapshot. With none, an account whose usage is unknown, so the options page shows the
      // account and not a signed-out form.
      if ((await loadSession()) === null) return null;
      const snapshot: CloudStatus = stored ?? {
        email: session.email,
        usage: null,
        subscription: null,
        checkedAt: 0,
      };
      if (!stored) await saveStatusFor(session.token, snapshot);
      return snapshot;
    },

    async peek(maxAgeMs) {
      if ((await loadSession()) === null) return null;
      const stored = await loadStatus();
      return stored && now() - stored.checkedAt < maxAgeMs ? stored : null;
    },

    async record(usage) {
      const session = await loadSession();
      if (!session) return;
      const stored = await loadStatus();
      await saveStatusFor(session.token, {
        email: stored?.email ?? session.email,
        usage,
        subscription: stored?.subscription ?? null,
        checkedAt: now(),
      });
    },
  };
}

/** Whether the account can still have one more photo analysed. */
export function canAnalyse(usage: CloudUsage): boolean {
  switch (usage.kind) {
    case 'plan':
      return (
        (usage.month.cap === null || usage.month.used < usage.month.cap) &&
        (usage.day.cap === null || usage.day.used < usage.day.cap)
      );
    case 'trial':
      return usage.trialLeft > 0;
    case 'none':
      return false;
  }
}

/**
 * The gate of both paid steps for a signed-in account: no analysis left is `quota`, then "Au
 * clic" is `manual`, else `ready`. `no_key` is only for no account at all. A usage never read (the
 * server was out of reach) is not a refusal: the step itself will tell the quota or the network
 * failure, so the card never sends a subscriber to add a Google key.
 */
export function cloudGate(status: CloudStatus | null, mode: AnalysisMode): Gate {
  if (!status) return 'no_key';
  if (status.usage && !canAnalyse(status.usage)) return 'quota';
  return mode === 'click' ? 'manual' : 'ready';
}

/**
 * Analyses left: what the month still allows, or what is left of the trial. null when it cannot
 * be known (the status was never read).
 */
export function cloudRemaining(status: CloudStatus | null): number | null {
  const usage = status?.usage;
  if (!usage) return null;
  switch (usage.kind) {
    case 'plan':
      return usage.month.cap === null ? null : Math.max(0, usage.month.cap - usage.month.used);
    case 'trial':
      return usage.trialLeft;
    case 'none':
      return 0;
  }
}

export interface CloudGates {
  loadGates(): Promise<Gates>;
  loadVisionRemaining(): Promise<number | null>;
}

/** The background's `loadGates` and `loadVisionRemaining` while signed in. */
export function createCloudGates(keeper: StatusKeeper): CloudGates {
  return {
    async loadGates() {
      const [status, settings] = await Promise.all([keeper.current(), loadSettings()]);
      const gate = cloudGate(status, settings.mode);
      return { image: gate, ai: gate };
    },
    async loadVisionRemaining() {
      return cloudRemaining(await keeper.current());
    },
  };
}

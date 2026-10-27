import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { saveSettings } from '../settings';
import { STATUS_MAX_AGE_MS } from './config';
import { loadSession, loadStatus, saveSession, saveStatusFor } from './session';
import {
  canAnalyse,
  cloudGate,
  cloudRemaining,
  createCloudGates,
  createStatusKeeper,
} from './status';
import { PLAN_USAGE, TRIAL_USAGE, makeClient } from './test-helpers';
import type { CloudStatus, CloudUsage } from './types';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
let clock = NOW;

const status = (usage: CloudUsage | null, checkedAt = NOW): CloudStatus => ({
  email: 'a@b.fr',
  usage,
  subscription: null,
  checkedAt,
});

beforeEach(async () => {
  fakeBrowser.reset();
  clock = NOW;
  await saveSession({ token: 'tok-1', email: 'a@b.fr' });
});

function keeper(client = makeClient()) {
  return { keeper: createStatusKeeper({ client, now: () => clock }), client };
}

describe('the status keeper', () => {
  it('is null when signed out, and asks nothing', async () => {
    await fakeBrowser.storage.local.clear();
    const { keeper: k, client } = keeper();
    expect(await k.current()).toBeNull();
    expect(client.me).not.toHaveBeenCalled();
  });

  it('reads the account the first time and stores it, the token left out', async () => {
    const { keeper: k, client } = keeper();
    const current = await k.current();
    expect(current).toEqual({ ...status(PLAN_USAGE), subscription: null });
    expect(client.me).toHaveBeenCalledTimes(1);
    expect(await loadStatus()).toEqual(current);
  });

  it('asks the server at most once a minute', async () => {
    const { keeper: k, client } = keeper();
    await k.current();
    clock += STATUS_MAX_AGE_MS - 1;
    await k.current();
    expect(client.me).toHaveBeenCalledTimes(1);
    clock += 2;
    await k.current();
    expect(client.me).toHaveBeenCalledTimes(2);
  });

  it('asks again at once with a maximum age of 0 (someone is looking at it)', async () => {
    const { keeper: k, client } = keeper();
    await k.current();
    await k.current(0);
    expect(client.me).toHaveBeenCalledTimes(2);
  });

  it('answers two callers with one request', async () => {
    const { keeper: k, client } = keeper();
    await Promise.all([k.current(), k.current(0), k.current()]);
    expect(client.me).toHaveBeenCalledTimes(1);
  });

  it('keeps the last snapshot when the server cannot be reached, and does not hammer it', async () => {
    const { keeper: k, client } = keeper();
    await k.current();
    vi.mocked(client.me).mockResolvedValue({ ok: false, reason: 'network' });
    clock += STATUS_MAX_AGE_MS + 1;
    expect(await k.current()).toEqual(status(PLAN_USAGE));
    // The failed attempt counts: the next gate within the minute does not try again.
    await k.current();
    expect(client.me).toHaveBeenCalledTimes(2);
  });

  it('makes an account whose usage is unknown when it never could be read', async () => {
    const { keeper: k, client } = keeper(
      makeClient({
        me: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'network' as const })),
      }),
    );
    await fakeBrowser.storage.local.remove('fripon:cloud:status:v1');
    expect(await k.current()).toEqual({
      email: 'a@b.fr',
      usage: null,
      subscription: null,
      checkedAt: 0,
    });
    expect(client.me).toHaveBeenCalledTimes(1);
    // The options page then shows the account, not a signed-out form.
    expect((await loadStatus())?.email).toBe('a@b.fr');
  });

  it('is null once the server has refused the session', async () => {
    const { keeper: k } = keeper(
      makeClient({
        me: vi.fn(async () => {
          // What the client does on a 401.
          await fakeBrowser.storage.local.clear();
          return { ok: false as const, reason: 'signed_out' as const };
        }),
      }),
    );
    expect(await k.current()).toBeNull();
    expect(await loadSession()).toBeNull();
  });

  it('keeps what a search answered, with the subscription it already knew', async () => {
    const { keeper: k } = keeper();
    const subscription = { status: 'active', periodEnd: 1_800_000_000_000 };
    await saveStatusFor('tok-1', { ...status(PLAN_USAGE, 1), subscription });
    clock = NOW + 5_000;
    await k.record({ ...PLAN_USAGE, month: { used: 13, cap: 300 } });
    expect(await loadStatus()).toEqual({
      email: 'a@b.fr',
      usage: { ...PLAN_USAGE, month: { used: 13, cap: 300 } },
      subscription,
      checkedAt: NOW + 5_000,
    });
  });

  it('counts a recorded usage as a fresh reading', async () => {
    const { keeper: k, client } = keeper();
    await k.record(TRIAL_USAGE);
    await k.current();
    expect(client.me).not.toHaveBeenCalled();
  });

  it('records nothing once signed out', async () => {
    const { keeper: k } = keeper();
    await fakeBrowser.storage.local.clear();
    await k.record(PLAN_USAGE);
    expect(await loadStatus()).toBeNull();
  });
});

describe('canAnalyse', () => {
  it('needs room under both caps of a plan', () => {
    expect(canAnalyse(PLAN_USAGE)).toBe(true);
    expect(canAnalyse({ ...PLAN_USAGE, month: { used: 300, cap: 300 } })).toBe(false);
    expect(canAnalyse({ ...PLAN_USAGE, day: { used: 40, cap: 40 } })).toBe(false);
    expect(canAnalyse({ ...PLAN_USAGE, day: { used: 99, cap: null } })).toBe(true);
  });

  it('needs analyses left in the trial, and never lets an account without a plan through', () => {
    expect(canAnalyse(TRIAL_USAGE)).toBe(true);
    expect(canAnalyse({ ...TRIAL_USAGE, trialLeft: 0 })).toBe(false);
    expect(canAnalyse({ ...TRIAL_USAGE, kind: 'none', trialLeft: 0 })).toBe(false);
  });
});

describe('cloudGate', () => {
  it('is ready when the account can analyse', () => {
    expect(cloudGate(status(PLAN_USAGE), 'auto')).toBe('ready');
    expect(cloudGate(status(TRIAL_USAGE), 'auto')).toBe('ready');
  });

  it('is manual in "Au clic" mode, when it would be ready', () => {
    expect(cloudGate(status(PLAN_USAGE), 'click')).toBe('manual');
  });

  it('is quota when a cap is reached, the trial is used up, or there is no plan', () => {
    const month = { ...PLAN_USAGE, month: { used: 300, cap: 300 } };
    const day = { ...PLAN_USAGE, day: { used: 40, cap: 40 } };
    const empty = { ...TRIAL_USAGE, trialLeft: 0 };
    const none: CloudUsage = { ...empty, kind: 'none' };
    for (const usage of [month, day, empty, none]) {
      expect(cloudGate(status(usage), 'auto')).toBe('quota');
      // The cap comes before the mode, as for the keys.
      expect(cloudGate(status(usage), 'click')).toBe('quota');
    }
  });

  it('is no_key when nothing is known: nothing is asked of the server', () => {
    expect(cloudGate(null, 'auto')).toBe('no_key');
    expect(cloudGate(status(null, 0), 'auto')).toBe('no_key');
  });
});

describe('cloudRemaining', () => {
  it('is what the month still allows for a plan, the trial left otherwise', () => {
    expect(cloudRemaining(status(PLAN_USAGE))).toBe(288);
    expect(cloudRemaining(status({ ...PLAN_USAGE, month: { used: 400, cap: 300 } }))).toBe(0);
    expect(cloudRemaining(status(TRIAL_USAGE))).toBe(10);
    expect(cloudRemaining(status({ ...TRIAL_USAGE, kind: 'none', trialLeft: 0 }))).toBe(0);
  });

  it('is unknown without a reading', () => {
    expect(cloudRemaining(null)).toBeNull();
    expect(cloudRemaining(status(null, 0))).toBeNull();
  });
});

describe('the gates of a signed-in account', () => {
  it('give both paid steps the same word, from the status and the mode', async () => {
    const { keeper: k } = keeper();
    const gates = createCloudGates(k);
    expect(await gates.loadGates()).toEqual({ image: 'ready', ai: 'ready' });
    await saveSettings({ mode: 'click' });
    expect(await gates.loadGates()).toEqual({ image: 'manual', ai: 'manual' });
  });

  it('say quota when the plan is used up, whatever the mode', async () => {
    const { keeper: k } = keeper(
      makeClient({
        me: vi.fn(() =>
          Promise.resolve({
            ok: true as const,
            me: {
              email: 'a@b.fr',
              usage: { ...PLAN_USAGE, day: { used: 40, cap: 40 } },
              subscription: null,
            },
          }),
        ),
      }),
    );
    const gates = createCloudGates(k);
    expect(await gates.loadGates()).toEqual({ image: 'quota', ai: 'quota' });
    await saveSettings({ mode: 'click' });
    expect(await gates.loadGates()).toEqual({ image: 'quota', ai: 'quota' });
  });

  it('never touch the personal keys or their counters', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' } });
    const { keeper: k } = keeper();
    expect((await createCloudGates(k).loadGates()).image).toBe('ready');
    const stored = await fakeBrowser.storage.local.get(null);
    expect(Object.keys(stored).filter((key) => key.startsWith('fripon:credits'))).toEqual([]);
  });

  it('count the credits left as the month of the plan', async () => {
    const { keeper: k } = keeper();
    expect(await createCloudGates(k).loadVisionRemaining()).toBe(288);
  });

  it('keep the last snapshot when the server is out of reach, and say no_key with none', async () => {
    const down = makeClient({
      me: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'network' as const })),
    });
    const { keeper: k } = keeper(down);
    await saveStatusFor('tok-1', status(PLAN_USAGE, 1));
    expect((await createCloudGates(k).loadGates()).image).toBe('ready');

    await fakeBrowser.storage.local.remove('fripon:cloud:status:v1');
    const fresh = createCloudGates(keeper(down).keeper);
    expect(await fresh.loadGates()).toEqual({ image: 'no_key', ai: 'no_key' });
    expect(await fresh.loadVisionRemaining()).toBeNull();
  });
});

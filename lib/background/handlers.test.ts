import { describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage } from '../messages';
import { DEFAULT_SETTINGS } from '../settings';
import { handleMessage, isAllowedSender, type BackgroundDeps } from './handlers';

const own = { id: 'abc', origin: 'chrome-extension://abc/' };
const page = 'https://www.vinted.fr/items/1-robe';
const optionsPage = 'chrome-extension://abc/options.html#keys';

function makeDeps(overrides: Partial<BackgroundDeps> = {}): BackgroundDeps {
  return {
    analyzeImage: vi.fn(() =>
      Promise.resolve({ ok: true as const, hash: '0'.repeat(16), catalogScore: 0.1 }),
    ),
    loadImageGate: vi.fn(() => Promise.resolve('ready' as const)),
    loadSettings: vi.fn(() =>
      Promise.resolve({ ...DEFAULT_SETTINGS, keys: { vision: 'AIzaV', gemini: 'AIzaG' } }),
    ),
    checkKey: vi.fn(() => Promise.resolve({ ok: true as const })),
    openOptions: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('isAllowedSender', () => {
  const analyze: RuntimeMessage = { type: 'analyzeImage', url: 'https://x.test/a.jpg' };
  const gate: RuntimeMessage = { type: 'getImageGate' };
  const open: RuntimeMessage = { type: 'openOptions', section: 'guide' };
  const test: RuntimeMessage = { type: 'testKey', provider: 'vision' };

  it('rejects every message from another extension or from nowhere', () => {
    for (const message of [analyze, gate, open, test]) {
      expect(isAllowedSender(message, { id: 'other', url: optionsPage }, own)).toBe(false);
      expect(isAllowedSender(message, { url: optionsPage }, own)).toBe(false);
    }
  });

  it('lets our content scripts ask for the gate, an image analysis or the options page', () => {
    for (const message of [analyze, gate, open]) {
      expect(isAllowedSender(message, { id: 'abc', url: page }, own)).toBe(true);
    }
  });

  it('only lets extension pages test a key', () => {
    expect(isAllowedSender(test, { id: 'abc', url: optionsPage }, own)).toBe(true);
    expect(isAllowedSender(test, { id: 'abc', url: page }, own)).toBe(false);
    expect(isAllowedSender(test, { id: 'abc' }, own)).toBe(false);
    // A page that merely looks like our origin.
    expect(
      isAllowedSender(test, { id: 'abc', url: 'https://evil.test/chrome-extension://abc/' }, own),
    ).toBe(false);
    expect(isAllowedSender(test, { id: 'abc', url: 'chrome-extension://abcd/x.html' }, own)).toBe(
      false,
    );
  });
});

describe('handleMessage', () => {
  it('forwards analyzeImage to the analyzer', async () => {
    const deps = makeDeps();
    const response = await handleMessage(
      { type: 'analyzeImage', url: 'https://x.test/a.jpg' },
      deps,
    );
    expect(deps.analyzeImage).toHaveBeenCalledWith('https://x.test/a.jpg');
    expect(response).toMatchObject({ ok: true });
  });

  it('answers getImageGate with the gate word and nothing else', async () => {
    const deps = makeDeps({ loadImageGate: vi.fn(() => Promise.resolve('manual' as const)) });
    expect(await handleMessage({ type: 'getImageGate' }, deps)).toBe('manual');
  });

  it('falls back to no_key when the gate cannot be computed', async () => {
    const deps = makeDeps({ loadImageGate: vi.fn(() => Promise.reject(new Error('storage'))) });
    expect(await handleMessage({ type: 'getImageGate' }, deps)).toBe('no_key');
  });

  it('opens the options page at the requested section', async () => {
    const deps = makeDeps();
    expect(await handleMessage({ type: 'openOptions', section: 'credits' }, deps)).toBeUndefined();
    expect(deps.openOptions).toHaveBeenCalledWith('credits');
    await handleMessage({ type: 'openOptions' }, deps);
    expect(deps.openOptions).toHaveBeenLastCalledWith(undefined);
  });

  it('still answers when the tab cannot be opened', async () => {
    const deps = makeDeps({ openOptions: vi.fn(() => Promise.reject(new Error('no tabs'))) });
    await expect(handleMessage({ type: 'openOptions' }, deps)).resolves.toBeUndefined();
  });

  it('tests the STORED key of the provider', async () => {
    const deps = makeDeps({
      checkKey: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'billing' as const })),
    });
    expect(await handleMessage({ type: 'testKey', provider: 'gemini' }, deps)).toEqual({
      ok: false,
      reason: 'billing',
    });
    expect(deps.checkKey).toHaveBeenCalledWith('gemini', 'AIzaG');
    await handleMessage({ type: 'testKey', provider: 'vision' }, deps);
    expect(deps.checkKey).toHaveBeenLastCalledWith('vision', 'AIzaV');
  });

  it('reports a network failure when the settings cannot be read', async () => {
    const deps = makeDeps({ loadSettings: vi.fn(() => Promise.reject(new Error('storage'))) });
    expect(await handleMessage({ type: 'testKey', provider: 'vision' }, deps)).toEqual({
      ok: false,
      reason: 'network',
    });
    expect(deps.checkKey).not.toHaveBeenCalled();
  });
});

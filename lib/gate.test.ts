import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { reserve } from './credits';
import { imageGate, loadGates, loadVisionRemaining } from './gate';
import { DEFAULT_SETTINGS, saveSettings, type Settings } from './settings';

const withKey: Settings = {
  ...DEFAULT_SETTINGS,
  keys: { vision: 'AIzaVision', gemini: '' },
};

describe('imageGate', () => {
  it('is no_key without a Vision key, whatever the rest says', () => {
    expect(imageGate(DEFAULT_SETTINGS, 'ok')).toBe('no_key');
    expect(imageGate({ ...DEFAULT_SETTINGS, mode: 'click' }, 'ok')).toBe('no_key');
    expect(imageGate(DEFAULT_SETTINGS, 'reached')).toBe('no_key');
  });

  it('ignores a Gemini key', () => {
    const geminiOnly = { ...DEFAULT_SETTINGS, keys: { vision: '', gemini: 'AIzaGemini' } };
    expect(imageGate(geminiOnly, 'ok')).toBe('no_key');
  });

  it('is quota once the Vision cap is reached, even in click mode', () => {
    expect(imageGate(withKey, 'reached')).toBe('quota');
    expect(imageGate({ ...withKey, mode: 'click' }, 'reached')).toBe('quota');
  });

  it('is manual in click mode', () => {
    expect(imageGate({ ...withKey, mode: 'click' }, 'ok')).toBe('manual');
    expect(imageGate({ ...withKey, mode: 'click' }, 'warning')).toBe('manual');
  });

  it('is ready with a key, credits left and automatic mode (a warning does not block)', () => {
    expect(imageGate(withKey, 'ok')).toBe('ready');
    expect(imageGate(withKey, 'warning')).toBe('ready');
  });
});

describe('loadGates', () => {
  const now = new Date('2026-10-20T21:30:00Z');

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('is no_key for both on a fresh install', async () => {
    expect(await loadGates(now)).toEqual({ image: 'no_key', ai: 'no_key' });
  });

  it('gives each step its own gate from its own key', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' } });
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'no_key' });
    await saveSettings({ keys: { gemini: 'AIzaGemini' } });
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'ready' });
  });

  it('turns each into manual in click mode', async () => {
    await saveSettings({ mode: 'click', keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' } });
    expect(await loadGates(now)).toEqual({ image: 'manual', ai: 'manual' });
  });

  it('turns the image gate into quota when the stored counter hits the stored cap, and back next month', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' }, caps: { vision: 3 } });
    await reserve('vision', 3, null, now);
    expect(await loadGates(now)).toEqual({ image: 'quota', ai: 'no_key' });
    expect(await loadGates(new Date('2026-11-01T07:00:00Z'))).toEqual({
      image: 'ready',
      ai: 'no_key',
    });
  });

  it('never lets a counter that cannot be read turn the other gate off', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' } });
    const get = browser.storage.local.get.bind(browser.storage.local);
    const failing = (counter: string) =>
      vi
        .spyOn(browser.storage.local, 'get')
        .mockImplementation(((keys: string) =>
          String(keys).includes(counter)
            ? Promise.reject(new Error('storage down'))
            : get(keys)) as never);

    failing('credits:v1:gemini');
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'no_key' });
    vi.restoreAllMocks();

    failing('credits:v1:vision');
    expect(await loadGates(now)).toEqual({ image: 'no_key', ai: 'ready' });
    vi.restoreAllMocks();
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'ready' });
  });

  it('rejects when the settings themselves cannot be read: the handler then answers no_key for both', async () => {
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('storage down'));
    await expect(loadGates(now)).rejects.toThrow('storage down');
    vi.restoreAllMocks();
  });

  it('lifts the quota when the cap is removed', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' }, caps: { vision: 3 } });
    await reserve('vision', 3, null, now);
    await saveSettings({ caps: { vision: null } });
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'no_key' });
  });

  it('turns the AI gate into quota on its own counter, and back the next day', async () => {
    await saveSettings({
      keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' },
      caps: { gemini: 2 },
    });
    await reserve('gemini', 2, null, now);
    expect(await loadGates(now)).toEqual({ image: 'ready', ai: 'quota' });
    expect(await loadGates(new Date('2026-10-21T08:00:00Z'))).toEqual({
      image: 'ready',
      ai: 'ready',
    });
  });
});

describe('loadVisionRemaining', () => {
  const now = new Date('2026-10-20T21:30:00Z');

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('is the default cap on a fresh install', async () => {
    expect(await loadVisionRemaining(now)).toBe(1_000);
  });

  it('counts down with the credits spent, and never goes below zero', async () => {
    await saveSettings({ caps: { vision: 3 } });
    await reserve('vision', 2, null, now);
    expect(await loadVisionRemaining(now)).toBe(1);
    await reserve('vision', 1, null, now);
    expect(await loadVisionRemaining(now)).toBe(0);
  });

  it('is null when the cap was removed', async () => {
    await saveSettings({ caps: { vision: null } });
    expect(await loadVisionRemaining(now)).toBeNull();
  });
});

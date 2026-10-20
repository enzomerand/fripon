import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { reserve } from './credits';
import { imageGate, loadImageGate } from './gate';
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

describe('loadImageGate', () => {
  const now = new Date('2026-10-20T21:30:00Z');

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('is no_key on a fresh install', async () => {
    expect(await loadImageGate(now)).toBe('no_key');
  });

  it('is ready once a Vision key is saved', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' } });
    expect(await loadImageGate(now)).toBe('ready');
  });

  it('turns into quota when the stored counter hits the stored cap, and back next month', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' }, caps: { vision: 3 } });
    await reserve('vision', 3, null, now);
    expect(await loadImageGate(now)).toBe('quota');
    expect(await loadImageGate(new Date('2026-11-01T07:00:00Z'))).toBe('ready');
  });

  it('lifts the quota when the cap is removed', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' }, caps: { vision: 3 } });
    await reserve('vision', 3, null, now);
    await saveSettings({ caps: { vision: null } });
    expect(await loadImageGate(now)).toBe('ready');
  });

  it('is manual in click mode', async () => {
    await saveSettings({ mode: 'click', keys: { vision: 'AIzaVision' } });
    expect(await loadImageGate(now)).toBe('manual');
  });
});

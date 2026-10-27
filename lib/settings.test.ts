import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  isPlausibleGoogleKey,
  loadSettings,
  parseSettings,
  saveSettings,
} from './settings';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('DEFAULT_SETTINGS', () => {
  it('analyses automatically, has no key and the free-tier caps', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      mode: 'auto',
      keys: { vision: '', gemini: '' },
      caps: { vision: 1_000, gemini: 100 },
    });
  });
});

describe('parseSettings', () => {
  it.each([undefined, null, 42, 'x', [], true])('gives the defaults for %j', (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a valid object as is', () => {
    const settings = {
      mode: 'click',
      keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' },
      caps: { vision: 500, gemini: null },
    };
    expect(parseSettings(settings)).toEqual(settings);
  });

  it('falls back field by field, never all at once', () => {
    expect(
      parseSettings({
        mode: 'sometimes',
        keys: { vision: 12, gemini: 'AIzaGemini' },
        caps: { vision: 'lots', gemini: 5 },
      }),
    ).toEqual({
      mode: 'auto',
      keys: { vision: '', gemini: 'AIzaGemini' },
      caps: { vision: 1_000, gemini: 5 },
    });
  });

  describe('the Gemini cap of the old default', () => {
    it('reads a stored 20, the default until the AI review shipped, as the new default', () => {
      expect(parseSettings({ caps: { vision: 500, gemini: 20 } }).caps).toEqual({
        vision: 500,
        gemini: 100,
      });
    });

    it('leaves every other Gemini cap as it is, no cap included', () => {
      for (const gemini of [1, 19, 21, 100, 250, null]) {
        expect(parseSettings({ caps: { gemini } }).caps.gemini).toBe(gemini);
      }
    });

    it('does not touch a Vision cap of 20', () => {
      expect(parseSettings({ caps: { vision: 20 } }).caps.vision).toBe(20);
    });

    it('is saved as the new default by the next save, whatever it changes', async () => {
      await browser.storage.local.set({
        [SETTINGS_KEY]: { mode: 'auto', keys: {}, caps: { vision: 1_000, gemini: 20 } },
      });
      expect((await loadSettings()).caps.gemini).toBe(100);
      await saveSettings({ mode: 'click' });
      const stored = (await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as {
        caps: { gemini: number };
      };
      expect(stored.caps.gemini).toBe(100);
    });
  });

  it('keeps a valid mode when the rest is garbage', () => {
    expect(parseSettings({ mode: 'click', keys: 'nope', caps: [] })).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'click',
    });
  });

  it('trims the keys', () => {
    expect(parseSettings({ keys: { vision: '  AIzaV \n', gemini: '   ' } }).keys).toEqual({
      vision: 'AIzaV',
      gemini: '',
    });
  });

  it('keeps null as "no cap" but rejects every other non-cap', () => {
    expect(parseSettings({ caps: { vision: null } }).caps.vision).toBeNull();
    for (const bad of [0, -3, 2.5, NaN, Infinity, '10', true, {}]) {
      expect(parseSettings({ caps: { vision: bad, gemini: bad } }).caps).toEqual(
        DEFAULT_SETTINGS.caps,
      );
    }
    expect(parseSettings({ caps: { vision: 1 } }).caps.vision).toBe(1);
  });
});

describe('isPlausibleGoogleKey', () => {
  const valid = 'AIza' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q_-';

  it('accepts AIza followed by 35 URL-safe characters', () => {
    expect(valid).toHaveLength(39);
    expect(isPlausibleGoogleKey(valid)).toBe(true);
  });

  it('rejects the wrong prefix, length or alphabet', () => {
    expect(isPlausibleGoogleKey('')).toBe(false);
    expect(isPlausibleGoogleKey(valid.slice(0, -1))).toBe(false);
    expect(isPlausibleGoogleKey(valid + 'x')).toBe(false);
    expect(isPlausibleGoogleKey('Bjza' + valid.slice(4))).toBe(false);
    expect(isPlausibleGoogleKey(valid.slice(0, -1) + '!')).toBe(false);
    expect(isPlausibleGoogleKey(` ${valid}`)).toBe(false);
  });
});

describe('loadSettings / saveSettings', () => {
  it('loads the defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('tolerates a corrupted stored value', async () => {
    await browser.storage.local.set({ [SETTINGS_KEY]: { mode: 7, keys: null } });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves one object under fripon:settings:v1 and returns it', async () => {
    const saved = await saveSettings({ mode: 'click' });
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, mode: 'click' });
    expect((await browser.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]).toEqual(saved);
    expect(await loadSettings()).toEqual(saved);
  });

  it('merges keys and caps per provider', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' }, caps: { vision: 200 } });
    const saved = await saveSettings({ keys: { gemini: 'AIzaGemini' }, caps: { gemini: null } });
    expect(saved).toEqual({
      mode: 'auto',
      keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' },
      caps: { vision: 200, gemini: null },
    });
  });

  it('can clear a key', async () => {
    await saveSettings({ keys: { vision: 'AIzaVision' } });
    expect((await saveSettings({ keys: { vision: '' } })).keys.vision).toBe('');
  });

  it('trims saved keys', async () => {
    expect((await saveSettings({ keys: { gemini: '  AIzaG  ' } })).keys.gemini).toBe('AIzaG');
  });

  it('ignores invalid patch fields instead of resetting them', async () => {
    await saveSettings({ mode: 'click', caps: { vision: 300 } });
    const saved = await saveSettings({
      mode: 'weird' as never,
      caps: { vision: 0, gemini: 1.5 },
    });
    expect(saved.mode).toBe('click');
    expect(saved.caps).toEqual({ vision: 300, gemini: 100 });
  });

  it('never loses a save to a racing one', async () => {
    const saved = await Promise.all([
      saveSettings({ mode: 'click' }),
      saveSettings({ keys: { vision: 'AIzaVision' } }),
      saveSettings({ keys: { gemini: 'AIzaGemini' } }),
      saveSettings({ caps: { vision: 42 } }),
      saveSettings({ caps: { gemini: null } }),
    ]);
    const expected = {
      mode: 'click',
      keys: { vision: 'AIzaVision', gemini: 'AIzaGemini' },
      caps: { vision: 42, gemini: null },
    };
    expect(await loadSettings()).toEqual(expected);
    expect(saved.at(-1)).toEqual(expected);
  });

  it('takes the settings lock, so it holds across contexts too', async () => {
    const request = vi.fn(<T>(_name: string, callback: () => Promise<T>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    await saveSettings({ mode: 'click' });
    vi.unstubAllGlobals();
    expect(request.mock.calls.map(([name]) => name)).toEqual(['fripon:settings']);
  });

  it('leaves the other storage keys alone', async () => {
    await browser.storage.local.set({ 'fripon:seller:v2:www.vinted.fr:1': { a: 1 } });
    await saveSettings({ mode: 'click' });
    expect(await browser.storage.local.get('fripon:seller:v2:www.vinted.fr:1')).toEqual({
      'fripon:seller:v2:www.vinted.fr:1': { a: 1 },
    });
  });
});

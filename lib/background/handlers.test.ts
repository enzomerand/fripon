import { describe, expect, it, vi } from 'vitest';
import type { RuntimeMessage } from '../messages';
import { handleMessage, isAllowedSender, type BackgroundDeps } from './handlers';

const own = { id: 'abc', origin: 'chrome-extension://abc/' };
const page = 'https://www.vinted.fr/items/1-robe';
const optionsPage = 'chrome-extension://abc/options.html#keys';
const REVIEW_INPUT = {
  photoUrl: 'https://images1.vinted.net/a.jpg',
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: ['Recherche d’image : non faite.'],
  fingerprint: ['Recherche d’image : non faite.'],
};

function makeDeps(overrides: Partial<BackgroundDeps> = {}): BackgroundDeps {
  return {
    analyzeImage: vi.fn(() =>
      Promise.resolve({ ok: true as const, hash: '0'.repeat(16), catalogScore: 0.1 }),
    ),
    searchImage: vi.fn(() => Promise.resolve({ status: 'ok' as const, matches: [] })),
    aiReview: vi.fn(() =>
      Promise.resolve({ status: 'ok' as const, review: { catalogPhoto: false, summary: 'Ok.' } }),
    ),
    loadGates: vi.fn(() => Promise.resolve({ image: 'ready' as const, ai: 'ready' as const })),
    loadVisionRemaining: vi.fn(() => Promise.resolve(640)),
    checkKey: vi.fn(() => Promise.resolve({ ok: true as const })),
    openOptions: vi.fn(() => Promise.resolve()),
    setBadge: vi.fn(() => Promise.resolve()),
    cloud: {
      status: vi.fn(() => Promise.resolve(null)),
      requestCode: vi.fn(() => Promise.resolve({ ok: true as const })),
      verify: vi.fn(() => Promise.resolve({ ok: true as const })),
      signOut: vi.fn(() => Promise.resolve()),
      checkout: vi.fn(() => Promise.resolve({ ok: true as const })),
      portal: vi.fn(() => Promise.resolve({ ok: true as const })),
      deleteAccount: vi.fn(() => Promise.resolve({ ok: true as const })),
    },
    ...overrides,
  };
}

describe('isAllowedSender', () => {
  const analyze: RuntimeMessage = { type: 'analyzeImage', url: 'https://x.test/a.jpg' };
  const search: RuntimeMessage = { type: 'searchImage', photoUrl: 'https://x.test/a.jpg' };
  const review: RuntimeMessage = { type: 'aiReview', input: REVIEW_INPUT };
  const gates: RuntimeMessage = { type: 'getGates' };
  const usage: RuntimeMessage = { type: 'getVisionUsage' };
  const open: RuntimeMessage = { type: 'openOptions', section: 'guide' };
  const test: RuntimeMessage = { type: 'testKey', provider: 'vision', key: 'AIzaX' };

  it('rejects every message from another extension or from nowhere', () => {
    for (const message of [analyze, search, review, gates, usage, open, test]) {
      expect(isAllowedSender(message, { id: 'other', url: optionsPage }, own)).toBe(false);
      expect(isAllowedSender(message, { url: optionsPage }, own)).toBe(false);
    }
  });

  it('lets our content scripts ask for the gates, the credits left, an image analysis, a search, a review or the options page', () => {
    for (const message of [analyze, search, review, gates, usage, open]) {
      expect(isAllowedSender(message, { id: 'abc', url: page }, own)).toBe(true);
    }
  });

  describe('setVerdictBadge', () => {
    const badge: RuntimeMessage = {
      type: 'setVerdictBadge',
      verdict: { level: 'clean', title: 'Rien de suspect' },
    };
    const tab = { id: 4 };

    it('lets a content script of a Vinted page, in a tab, set or clear its badge', () => {
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab }, own)).toBe(true);
      expect(
        isAllowedSender(
          { type: 'setVerdictBadge', verdict: null },
          { id: 'abc', url: 'https://www.vinted.co.uk/items/2', tab },
          own,
        ),
      ).toBe(true);
    });

    it('refuses a tab that is no real tab, and a frame that is not the top one', () => {
      // chrome.tabs.TAB_ID_NONE
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab: { id: -1 } }, own)).toBe(false);
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab, frameId: 3 }, own)).toBe(false);
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab: { id: 0 } }, own)).toBe(true);
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab, frameId: 0 }, own)).toBe(true);
    });

    it('refuses an extension page, which has no tab', () => {
      expect(isAllowedSender(badge, { id: 'abc', url: optionsPage }, own)).toBe(false);
      expect(isAllowedSender(badge, { id: 'abc', url: page }, own)).toBe(false);
      expect(isAllowedSender(badge, { id: 'abc', url: page, tab: {} }, own)).toBe(false);
    });

    it('refuses a page that is not Vinted, even in a tab', () => {
      for (const url of [
        'https://evil.test/items/1',
        'https://www.vinted.fr.evil.test/items/1',
        'http://www.vinted.fr/items/1',
        optionsPage,
      ]) {
        expect(isAllowedSender(badge, { id: 'abc', url, tab }, own)).toBe(false);
      }
      expect(isAllowedSender(badge, { id: 'abc', tab }, own)).toBe(false);
    });

    it('refuses another extension, even from a Vinted tab', () => {
      expect(isAllowedSender(badge, { id: 'other', url: page, tab }, own)).toBe(false);
      expect(isAllowedSender(badge, { url: page, tab }, own)).toBe(false);
    });
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

  it('forwards searchImage to the searcher with the photo URL', async () => {
    const matches = [
      { platform: 'Shein', url: 'https://fr.shein.com/x-p-1.html', exact: true, price: null },
    ];
    const deps = makeDeps({
      searchImage: vi.fn(() => Promise.resolve({ status: 'ok' as const, matches })),
    });
    const response = await handleMessage(
      { type: 'searchImage', photoUrl: 'https://images1.vinted.net/a.jpg' },
      deps,
    );
    expect(deps.searchImage).toHaveBeenCalledWith('https://images1.vinted.net/a.jpg', false, false);
    expect(response).toEqual({ status: 'ok', matches });
  });

  it('asks the searcher for the cache only when the page says so', async () => {
    const deps = makeDeps({
      searchImage: vi.fn(() => Promise.resolve({ status: 'not_cached' as const })),
    });
    const photoUrl = 'https://images1.vinted.net/a.jpg';
    expect(await handleMessage({ type: 'searchImage', photoUrl, cacheOnly: true }, deps)).toEqual({
      status: 'not_cached',
    });
    expect(deps.searchImage).toHaveBeenLastCalledWith(photoUrl, true, false);
    await handleMessage({ type: 'searchImage', photoUrl, cacheOnly: false }, deps);
    expect(deps.searchImage).toHaveBeenLastCalledWith(photoUrl, false, false);
  });

  it('tells the searcher and the reviewer when the user asked for another attempt', async () => {
    const deps = makeDeps();
    const photoUrl = 'https://images1.vinted.net/a.jpg';
    await handleMessage({ type: 'searchImage', photoUrl, retry: true }, deps);
    expect(deps.searchImage).toHaveBeenLastCalledWith(photoUrl, false, true);
    await handleMessage({ type: 'aiReview', input: REVIEW_INPUT, retry: true }, deps);
    expect(deps.aiReview).toHaveBeenLastCalledWith(REVIEW_INPUT, false, true);
  });

  it('still answers a searchImage whose searcher rejects', async () => {
    const deps = makeDeps({ searchImage: vi.fn(() => Promise.reject(new Error('boom'))) });
    expect(
      await handleMessage(
        { type: 'searchImage', photoUrl: 'https://images1.vinted.net/a.jpg' },
        deps,
      ),
    ).toEqual({ status: 'error', reason: 'network' });
  });

  it('forwards aiReview to the reviewer with the input, and asks for the cache only when told', async () => {
    const deps = makeDeps();
    expect(await handleMessage({ type: 'aiReview', input: REVIEW_INPUT }, deps)).toEqual({
      status: 'ok',
      review: { catalogPhoto: false, summary: 'Ok.' },
    });
    expect(deps.aiReview).toHaveBeenLastCalledWith(REVIEW_INPUT, false, false);
    await handleMessage({ type: 'aiReview', input: REVIEW_INPUT, cacheOnly: true }, deps);
    expect(deps.aiReview).toHaveBeenLastCalledWith(REVIEW_INPUT, true, false);
  });

  it('still answers an aiReview whose reviewer rejects', async () => {
    const deps = makeDeps({ aiReview: vi.fn(() => Promise.reject(new Error('boom'))) });
    expect(await handleMessage({ type: 'aiReview', input: REVIEW_INPUT }, deps)).toEqual({
      status: 'error',
      reason: 'network',
    });
  });

  it('answers getGates with the two gate words and nothing else', async () => {
    const deps = makeDeps({
      loadGates: vi.fn(() => Promise.resolve({ image: 'manual' as const, ai: 'quota' as const })),
    });
    expect(await handleMessage({ type: 'getGates' }, deps)).toEqual({
      image: 'manual',
      ai: 'quota',
    });
  });

  it('falls back to no_key for both when the gates cannot be computed', async () => {
    const deps = makeDeps({ loadGates: vi.fn(() => Promise.reject(new Error('storage'))) });
    expect(await handleMessage({ type: 'getGates' }, deps)).toEqual({
      image: 'no_key',
      ai: 'no_key',
    });
  });

  it('answers getVisionUsage with the credits left and nothing else', async () => {
    const deps = makeDeps({ loadVisionRemaining: vi.fn(() => Promise.resolve(37)) });
    expect(await handleMessage({ type: 'getVisionUsage' }, deps)).toEqual({ remaining: 37 });
  });

  it('answers getVisionUsage with no count when there is no cap or it cannot be read', async () => {
    const noCap = makeDeps({ loadVisionRemaining: vi.fn(() => Promise.resolve(null)) });
    expect(await handleMessage({ type: 'getVisionUsage' }, noCap)).toEqual({ remaining: null });
    const broken = makeDeps({ loadVisionRemaining: vi.fn(() => Promise.reject(new Error('x'))) });
    expect(await handleMessage({ type: 'getVisionUsage' }, broken)).toEqual({ remaining: null });
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

  it('puts the verdict on the badge of the tab it comes from', async () => {
    const deps = makeDeps();
    const verdict = { level: 'review' as const, title: 'À vérifier' };
    expect(
      await handleMessage({ type: 'setVerdictBadge', verdict }, deps, { tabId: 4 }),
    ).toBeUndefined();
    expect(deps.setBadge).toHaveBeenCalledWith(4, verdict);
    await handleMessage({ type: 'setVerdictBadge', verdict: null }, deps, { tabId: 4 });
    expect(deps.setBadge).toHaveBeenLastCalledWith(4, null);
  });

  it('draws no badge when the message comes from no tab', async () => {
    const deps = makeDeps();
    const verdict = { level: 'clean' as const, title: 'Rien de suspect' };
    await handleMessage({ type: 'setVerdictBadge', verdict }, deps);
    await handleMessage({ type: 'setVerdictBadge', verdict }, deps, { tabId: undefined });
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it('still answers when the badge cannot be drawn', async () => {
    const deps = makeDeps({ setBadge: vi.fn(() => Promise.reject(new Error('No tab with id'))) });
    await expect(
      handleMessage({ type: 'setVerdictBadge', verdict: null }, deps, { tabId: 4 }),
    ).resolves.toBeUndefined();
  });

  it('tests the key it is given, for the provider it is given', async () => {
    const deps = makeDeps({
      checkKey: vi.fn(() => Promise.resolve({ ok: false as const, reason: 'billing' as const })),
    });
    expect(
      await handleMessage({ type: 'testKey', provider: 'gemini', key: 'AIzaCandidate' }, deps),
    ).toEqual({ ok: false, reason: 'billing' });
    expect(deps.checkKey).toHaveBeenCalledWith('gemini', 'AIzaCandidate');
    await handleMessage({ type: 'testKey', provider: 'vision', key: 'AIzaOther' }, deps);
    expect(deps.checkKey).toHaveBeenLastCalledWith('vision', 'AIzaOther');
  });
});

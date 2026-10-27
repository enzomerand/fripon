import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { isRuntimeMessage, sendMessage } from './messages';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendMessage', () => {
  it('forwards the request and returns the typed response', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: true, hash: '00000000000000ff', catalogScore: 0.4 } as never);
    const response = await sendMessage({
      type: 'analyzeImage',
      url: 'https://images1.vinted.net/a.jpg',
    });
    expect(spy).toHaveBeenCalledWith({
      type: 'analyzeImage',
      url: 'https://images1.vinted.net/a.jpg',
    });
    expect(response).toEqual({ ok: true, hash: '00000000000000ff', catalogScore: 0.4 });
  });

  it('passes an error response through', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: false,
      error: 'HTTP 404',
    } as never);
    const response = await sendMessage({
      type: 'analyzeImage',
      url: 'https://images1.vinted.net/b.jpg',
    });
    expect(response).toEqual({ ok: false, error: 'HTTP 404' });
  });
});

describe('sendMessage (searchImage)', () => {
  it('sends the photo URL and returns the matches', async () => {
    const answer = {
      status: 'ok',
      matches: [
        { platform: 'Shein', url: 'https://fr.shein.com/x-p-1.html', exact: true, price: null },
      ],
    };
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(answer as never);
    const response = await sendMessage({
      type: 'searchImage',
      photoUrl: 'https://images1.vinted.net/a.jpg',
    });
    expect(spy).toHaveBeenCalledWith({
      type: 'searchImage',
      photoUrl: 'https://images1.vinted.net/a.jpg',
    });
    expect(response).toEqual(answer);
  });
});

describe('sendMessage (settings messages)', () => {
  it('returns the gates', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ image: 'quota', ai: 'ready' } as never);
    expect(await sendMessage({ type: 'getGates' })).toEqual({ image: 'quota', ai: 'ready' });
    expect(spy).toHaveBeenCalledWith({ type: 'getGates' });
  });

  it('returns the Vision credits left', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ remaining: 12 } as never);
    expect(await sendMessage({ type: 'getVisionUsage' })).toEqual({ remaining: 12 });
    expect(spy).toHaveBeenCalledWith({ type: 'getVisionUsage' });
  });

  it('sends the listing to review and returns the review', async () => {
    const input = {
      photoUrl: 'https://images1.vinted.net/a.jpg',
      title: 'Robe',
      description: 'Belle robe',
      price: '12,00 €',
      signals: ['Vendeur : rien de notable.'],
      fingerprint: ["Recherche d'image : non faite."],
    };
    const answer = {
      status: 'ok',
      review: { catalogPhoto: true, summary: 'Une photo de studio.' },
    };
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(answer as never);
    expect(await sendMessage({ type: 'aiReview', input, cacheOnly: true })).toEqual(answer);
    expect(spy).toHaveBeenCalledWith({ type: 'aiReview', input, cacheOnly: true });
  });

  it('sends the candidate key to test and returns the result', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: false, reason: 'billing' } as never);
    expect(
      await sendMessage({ type: 'testKey', provider: 'gemini', key: 'AIzaCandidate' }),
    ).toEqual({
      ok: false,
      reason: 'billing',
    });
    expect(spy).toHaveBeenCalledWith({ type: 'testKey', provider: 'gemini', key: 'AIzaCandidate' });
  });

  it('asks to open the options page at a section', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await sendMessage({ type: 'openOptions', section: 'guide' });
    expect(spy).toHaveBeenCalledWith({ type: 'openOptions', section: 'guide' });
  });
});

describe('isRuntimeMessage', () => {
  it('accepts getGates with nothing else, and no longer knows getImageGate', () => {
    expect(isRuntimeMessage({ type: 'getGates' })).toBe(true);
    expect(isRuntimeMessage({ type: 'getImageGate' })).toBe(false);
  });

  it('accepts getVisionUsage with nothing else', () => {
    expect(isRuntimeMessage({ type: 'getVisionUsage' })).toBe(true);
  });

  it('accepts an aiReview request with a well-formed input only', () => {
    const input = {
      photoUrl: 'https://x.test/a.jpg',
      title: 'Robe',
      description: '',
      price: '12,00 €',
      signals: ['a', 'b'],
      fingerprint: ['a'],
    };
    expect(isRuntimeMessage({ type: 'aiReview', input })).toBe(true);
    expect(isRuntimeMessage({ type: 'aiReview', input, cacheOnly: true })).toBe(true);
    expect(isRuntimeMessage({ type: 'aiReview', input, cacheOnly: 'yes' })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview' })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: null })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, signals: 'a' } })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, signals: [1] } })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, title: 3 } })).toBe(false);
    expect(
      isRuntimeMessage({ type: 'aiReview', input: { ...input, fingerprint: undefined } }),
    ).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, photoUrl: undefined } })).toBe(
      false,
    );
  });

  it('accepts openOptions without a section or with a known one', () => {
    expect(isRuntimeMessage({ type: 'openOptions' })).toBe(true);
    for (const section of ['guide', 'keys', 'credits']) {
      expect(isRuntimeMessage({ type: 'openOptions', section })).toBe(true);
    }
    expect(isRuntimeMessage({ type: 'openOptions', section: 'welcome' })).toBe(false);
    expect(isRuntimeMessage({ type: 'openOptions', section: '../x' })).toBe(false);
    expect(isRuntimeMessage({ type: 'openOptions', section: 3 })).toBe(false);
  });

  it('accepts setVerdictBadge with a known level and a short title, or with null to clear', () => {
    const verdict = { level: 'dropshipping', title: 'Dropshipping probable' };
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict })).toBe(true);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: null })).toBe(true);
    for (const level of ['dropshipping', 'resold', 'review', 'clean']) {
      expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: { level, title: 'x' } })).toBe(
        true,
      );
    }
    expect(
      isRuntimeMessage({
        type: 'setVerdictBadge',
        verdict: { ...verdict, title: 'x'.repeat(120) },
      }),
    ).toBe(true);
  });

  it('refuses a setVerdictBadge without a verdict, or with a malformed one', () => {
    const verdict = { level: 'clean', title: 'Rien de suspect' };
    expect(isRuntimeMessage({ type: 'setVerdictBadge' })).toBe(false);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: 'clean' })).toBe(false);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: [] })).toBe(false);
    expect(
      isRuntimeMessage({ type: 'setVerdictBadge', verdict: { ...verdict, level: 'red' } }),
    ).toBe(false);
    // Properties of Object.prototype are not levels.
    expect(
      isRuntimeMessage({ type: 'setVerdictBadge', verdict: { ...verdict, level: 'constructor' } }),
    ).toBe(false);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: { title: 'Rien' } })).toBe(false);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: { ...verdict, title: '' } })).toBe(
      false,
    );
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: { ...verdict, title: 4 } })).toBe(
      false,
    );
    expect(
      isRuntimeMessage({
        type: 'setVerdictBadge',
        verdict: { ...verdict, title: 'x'.repeat(121) },
      }),
    ).toBe(false);
    expect(isRuntimeMessage({ type: 'setVerdictBadge', verdict: { level: 'clean' } })).toBe(false);
  });

  it('refuses a setVerdictBadge whose title is blank or spans several lines', () => {
    const send = (title: string) =>
      isRuntimeMessage({ type: 'setVerdictBadge', verdict: { level: 'clean', title } });
    for (const blank of [' ', '   ', '\t', '\n', ' \u00a0 ']) expect(send(blank)).toBe(false);
    for (const lines of ['a\nb', 'a\r\nb', 'a\rb', 'Rien\n', '\nRien']) {
      expect(send(lines)).toBe(false);
    }
    expect(send('Rien de suspect (sans recherche d’image)')).toBe(true);
    expect(send(' Rien ')).toBe(true);
  });

  it('accepts testKey for a known provider only', () => {
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision', key: 'AIzaX' })).toBe(true);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'gemini', key: 'AIzaX' })).toBe(true);
    expect(isRuntimeMessage({ type: 'testKey', key: 'AIzaX' })).toBe(false);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'openai', key: 'AIzaX' })).toBe(false);
  });

  it('needs the key to test, as a string', () => {
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision' })).toBe(false);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision', key: '' })).toBe(true);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision', key: 12 })).toBe(false);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision', key: null })).toBe(false);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision', key: { a: 1 } })).toBe(false);
  });

  it('accepts a searchImage request with a photoUrl string only', () => {
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl: 'https://x.test/a.jpg' })).toBe(true);
    expect(isRuntimeMessage({ type: 'searchImage' })).toBe(false);
    // `url` is the analyzeImage field: not enough here.
    expect(isRuntimeMessage({ type: 'searchImage', url: 'https://x.test/a.jpg' })).toBe(false);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl: 12 })).toBe(false);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl: null })).toBe(false);
  });

  it('accepts cacheOnly on a searchImage request only as a boolean', () => {
    const photoUrl = 'https://x.test/a.jpg';
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, cacheOnly: true })).toBe(true);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, cacheOnly: false })).toBe(true);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, cacheOnly: 'yes' })).toBe(false);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, cacheOnly: 1 })).toBe(false);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, cacheOnly: null })).toBe(false);
  });

  it('accepts retry on a searchImage or an aiReview request only as a boolean', () => {
    const photoUrl = 'https://x.test/a.jpg';
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, retry: true })).toBe(true);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, retry: false })).toBe(true);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, retry: 'yes' })).toBe(false);
    expect(isRuntimeMessage({ type: 'searchImage', photoUrl, retry: 1 })).toBe(false);
    const input = {
      photoUrl,
      title: 'Robe',
      description: '',
      price: '12,00 €',
      signals: [],
      fingerprint: [],
    };
    expect(isRuntimeMessage({ type: 'aiReview', input, retry: true })).toBe(true);
    expect(isRuntimeMessage({ type: 'aiReview', input, retry: null })).toBe(false);
  });

  it('accepts a well-formed analyzeImage request only', () => {
    expect(isRuntimeMessage({ type: 'analyzeImage', url: 'https://x.test/a.jpg' })).toBe(true);
    expect(isRuntimeMessage({ type: 'analyzeImage' })).toBe(false);
    expect(isRuntimeMessage({ type: 'other', url: 'x' })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage('analyzeImage')).toBe(false);
  });
});

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

  it('sends the listing to review and returns the review', async () => {
    const input = {
      photoUrl: 'https://images1.vinted.net/a.jpg',
      title: 'Robe',
      description: 'Belle robe',
      price: '12,00 €',
      signals: ['Vendeur : rien de notable.'],
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

  it('accepts an aiReview request with a well-formed input only', () => {
    const input = {
      photoUrl: 'https://x.test/a.jpg',
      title: 'Robe',
      description: '',
      price: '12,00 €',
      signals: ['a', 'b'],
    };
    expect(isRuntimeMessage({ type: 'aiReview', input })).toBe(true);
    expect(isRuntimeMessage({ type: 'aiReview', input, cacheOnly: true })).toBe(true);
    expect(isRuntimeMessage({ type: 'aiReview', input, cacheOnly: 'yes' })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview' })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: null })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, signals: 'a' } })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, signals: [1] } })).toBe(false);
    expect(isRuntimeMessage({ type: 'aiReview', input: { ...input, title: 3 } })).toBe(false);
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

  it('accepts a well-formed analyzeImage request only', () => {
    expect(isRuntimeMessage({ type: 'analyzeImage', url: 'https://x.test/a.jpg' })).toBe(true);
    expect(isRuntimeMessage({ type: 'analyzeImage' })).toBe(false);
    expect(isRuntimeMessage({ type: 'other', url: 'x' })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage('analyzeImage')).toBe(false);
  });
});

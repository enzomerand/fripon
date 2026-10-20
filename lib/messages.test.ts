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

describe('sendMessage (settings messages)', () => {
  it('returns the image gate', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue('quota' as never);
    expect(await sendMessage({ type: 'getImageGate' })).toBe('quota');
    expect(spy).toHaveBeenCalledWith({ type: 'getImageGate' });
  });

  it('sends the provider only, never a key, to test a key', async () => {
    const spy = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue({ ok: false, reason: 'billing' } as never);
    expect(await sendMessage({ type: 'testKey', provider: 'vision' })).toEqual({
      ok: false,
      reason: 'billing',
    });
    expect(spy).toHaveBeenCalledWith({ type: 'testKey', provider: 'vision' });
  });

  it('asks to open the options page at a section', async () => {
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await sendMessage({ type: 'openOptions', section: 'guide' });
    expect(spy).toHaveBeenCalledWith({ type: 'openOptions', section: 'guide' });
  });
});

describe('isRuntimeMessage', () => {
  it('accepts getImageGate with nothing else', () => {
    expect(isRuntimeMessage({ type: 'getImageGate' })).toBe(true);
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
    expect(isRuntimeMessage({ type: 'testKey', provider: 'vision' })).toBe(true);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'gemini' })).toBe(true);
    expect(isRuntimeMessage({ type: 'testKey' })).toBe(false);
    expect(isRuntimeMessage({ type: 'testKey', provider: 'openai' })).toBe(false);
  });

  it('accepts a well-formed analyzeImage request only', () => {
    expect(isRuntimeMessage({ type: 'analyzeImage', url: 'https://x.test/a.jpg' })).toBe(true);
    expect(isRuntimeMessage({ type: 'analyzeImage' })).toBe(false);
    expect(isRuntimeMessage({ type: 'other', url: 'x' })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage('analyzeImage')).toBe(false);
  });
});

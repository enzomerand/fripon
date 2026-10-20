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

describe('isRuntimeMessage', () => {
  it('accepts a well-formed analyzeImage request only', () => {
    expect(isRuntimeMessage({ type: 'analyzeImage', url: 'https://x.test/a.jpg' })).toBe(true);
    expect(isRuntimeMessage({ type: 'analyzeImage' })).toBe(false);
    expect(isRuntimeMessage({ type: 'other', url: 'x' })).toBe(false);
    expect(isRuntimeMessage(null)).toBe(false);
    expect(isRuntimeMessage('analyzeImage')).toBe(false);
  });
});

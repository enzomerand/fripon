import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../entrypoints/background';
import { saveSettings } from '../lib/settings';

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string },
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

const ORIGIN = browser.runtime.getURL('/');

function start() {
  let listener: Listener | undefined;
  vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(((fn: Listener) => {
    listener = fn;
  }) as never);
  background.main();
  if (!listener) throw new Error('no onMessage listener registered');
  const registered = listener;
  /** Sends a message and resolves with the response, or 'no answer' when it is not handled. */
  return (message: unknown, sender: { id?: string; url?: string }) =>
    new Promise<unknown>((resolve) => {
      const handled = registered(message, sender, resolve);
      if (!handled) resolve('no answer');
    });
}

const fromPage = { id: browser.runtime.id, url: 'https://www.vinted.fr/items/1-robe' };
const fromOptions = { id: browser.runtime.id, url: `${ORIGIN}options.html` };

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('background', () => {
  it('answers getImageGate from the stored settings', async () => {
    const send = start();
    expect(await send({ type: 'getImageGate' }, fromPage)).toBe('no_key');
    await saveSettings({ keys: { vision: 'AIzaVision' } });
    expect(await send({ type: 'getImageGate' }, fromPage)).toBe('ready');
    await saveSettings({ mode: 'click' });
    expect(await send({ type: 'getImageGate' }, fromPage)).toBe('manual');
  });

  it('never puts a key in an answer to a content script', async () => {
    const send = start();
    await saveSettings({ keys: { vision: 'AIzaSECRETSECRETSECRETSECRETSECRET1234' } });
    const answer = await send({ type: 'getImageGate' }, fromPage);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('ignores messages from another extension and unknown messages', async () => {
    const send = start();
    expect(await send({ type: 'getImageGate' }, { id: 'other', url: fromPage.url })).toBe(
      'no answer',
    );
    expect(await send({ type: 'whatever' }, fromPage)).toBe('no answer');
  });

  it('refuses testKey from a content script, accepts it from the options page', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    await saveSettings({ keys: { gemini: 'AIzaGemini' } });
    const send = start();

    expect(await send({ type: 'testKey', provider: 'gemini' }, fromPage)).toBe('no answer');
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await send({ type: 'testKey', provider: 'gemini' }, fromOptions)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('opens the options page in a tab at the requested section', async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const send = start();
    await send({ type: 'openOptions', section: 'guide' }, fromPage);
    expect(create).toHaveBeenCalledWith({ url: `${ORIGIN}options.html#guide` });
    await send({ type: 'openOptions' }, fromPage);
    expect(create).toHaveBeenLastCalledWith({ url: `${ORIGIN}options.html` });
  });

  it('opens the options page when the toolbar button is clicked', () => {
    const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    let clicked: (() => void) | undefined;
    vi.spyOn(browser.action.onClicked, 'addListener').mockImplementation(((fn: () => void) => {
      clicked = fn;
    }) as never);
    start();
    clicked?.();
    expect(open).toHaveBeenCalledOnce();
  });

  it('welcomes a new install, and only a new install', () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    let installed: ((details: { reason: string }) => void) | undefined;
    vi.spyOn(browser.runtime.onInstalled, 'addListener').mockImplementation(((
      fn: (details: { reason: string }) => void,
    ) => {
      installed = fn;
    }) as never);
    start();
    installed?.({ reason: 'update' });
    installed?.({ reason: 'browser_update' });
    expect(create).not.toHaveBeenCalled();
    installed?.({ reason: 'install' });
    expect(create).toHaveBeenCalledWith({ url: `${ORIGIN}options.html#welcome` });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../entrypoints/background';
import { getUsage } from '../lib/credits';
import { PENDING_SECTION_KEY } from '../lib/options-nav';
import { loadSettings, saveSettings } from '../lib/settings';

type Sender = { id?: string; url?: string };
type Listener = (
  message: unknown,
  sender: Sender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

const ORIGIN = browser.runtime.getURL('/');
const pending = async () =>
  (await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY];

function start() {
  let listener: Listener | undefined;
  vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(((fn: Listener) => {
    listener = fn;
  }) as never);
  background.main();
  if (!listener) throw new Error('no onMessage listener registered');
  const registered = listener;
  /** Sends a message and resolves with the response, or 'no answer' when it is not handled. */
  return (message: unknown, sender: Sender) =>
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
  it('answers getGates from the stored settings, one gate per paid step', async () => {
    const send = start();
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'no_key', ai: 'no_key' });
    await saveSettings({ keys: { vision: 'AIzaVision' } });
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'ready', ai: 'no_key' });
    await saveSettings({ keys: { gemini: 'AIzaGemini' } });
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'ready', ai: 'ready' });
    await saveSettings({ mode: 'click' });
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'manual', ai: 'manual' });
  });

  it('never puts a key in an answer to a content script', async () => {
    const send = start();
    await saveSettings({
      keys: {
        vision: 'AIzaSECRETSECRETSECRETSECRETSECRET1234',
        gemini: 'AIzaSECRETSECRETSECRETSECRETSECRET5678',
      },
    });
    const answer = await send({ type: 'getGates' }, fromPage);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('ignores messages from another extension and unknown messages', async () => {
    const send = start();
    expect(await send({ type: 'getGates' }, { id: 'other', url: fromPage.url })).toBe('no answer');
    expect(await send({ type: 'getImageGate' }, fromPage)).toBe('no answer');
    expect(await send({ type: 'whatever' }, fromPage)).toBe('no answer');
  });

  describe('testKey', () => {
    function stubGoogle(status = 200) {
      const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() =>
        Promise.resolve(new Response('{}', { status })),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }
    const headerKey = (fetchMock: ReturnType<typeof stubGoogle>, call = 0) =>
      (fetchMock.mock.calls[call]?.[1].headers as Record<string, string>)['x-goog-api-key'];

    it('refuses a content script, whatever key it brings', async () => {
      const fetchMock = stubGoogle();
      const send = start();

      expect(await send({ type: 'testKey', provider: 'gemini', key: 'AIzaX' }, fromPage)).toBe(
        'no answer',
      );
      expect(await send({ type: 'testKey', provider: 'gemini', key: '' }, fromPage)).toBe(
        'no answer',
      );
      // Without a key the message is not even a valid request.
      expect(await send({ type: 'testKey', provider: 'gemini' }, fromOptions)).toBe('no answer');
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('tests the key an extension page sends, in the header and nowhere else', async () => {
      const fetchMock = stubGoogle();
      const send = start();

      expect(
        await send({ type: 'testKey', provider: 'gemini', key: 'AIzaCandidate' }, fromOptions),
      ).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(headerKey(fetchMock)).toBe('AIzaCandidate');
      expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('AIzaCandidate');
      vi.unstubAllGlobals();
    });

    it('leaves the saved key alone, whatever the verdict on the candidate', async () => {
      const fetchMock = stubGoogle(400);
      await saveSettings({ keys: { gemini: 'AIzaSaved' } });
      const send = start();

      const answer = await send(
        { type: 'testKey', provider: 'gemini', key: 'AIzaCandidate' },
        fromOptions,
      );
      expect(answer).toEqual({ ok: false, reason: 'invalid' });
      expect(headerKey(fetchMock)).toBe('AIzaCandidate');
      expect((await loadSettings()).keys.gemini).toBe('AIzaSaved');
      vi.unstubAllGlobals();
    });
  });

  describe('searchImage', () => {
    const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
    // The background remembers a refused key in memory across tests: each test gets its own key.
    let KEY = '';
    let keyCount = 0;
    beforeEach(() => {
      KEY = `AIzaSECRETSECRETSECRETSECRETSECRET${String(++keyCount).padStart(4, '0')}`;
    });
    const FOUND = {
      responses: [
        {
          webDetection: {
            pagesWithMatchingImages: [
              {
                url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
                fullMatchingImages: [{ url: 'https://img.example.test/a.jpg' }],
              },
            ],
          },
        },
      ],
    };

    /** The Vinted CDN answers with a few bytes, Vision with `visionAnswer`. */
    function stubWeb(visionAnswer: () => Response) {
      const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((url) =>
        Promise.resolve(
          String(url).startsWith('https://vision.googleapis.com/')
            ? visionAnswer()
            : new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }
    /** Google's answer for a project without billing: the key is refused. */
    const billingOff = () =>
      Response.json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'This API method requires billing to be enabled.',
          },
        },
        { status: 403 },
      );
    const visionCalls = (fetchMock: ReturnType<typeof stubWeb>) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('vision.googleapis.com'));
    const used = async () => (await getUsage('vision', null)).used;

    it('searches the photo with the saved key, spends one credit and answers with the matches only', async () => {
      const fetchMock = stubWeb(() => Response.json(FOUND));
      await saveSettings({ keys: { vision: KEY } });
      const send = start();

      const answer = await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage);
      expect(answer).toEqual({
        status: 'ok',
        matches: [
          {
            platform: 'Shein',
            url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
            exact: true,
            price: null,
          },
        ],
      });
      expect(JSON.stringify(answer)).not.toContain('SECRET');

      const calls = visionCalls(fetchMock);
      expect(calls).toHaveLength(1);
      const [url, init] = calls[0] as [string, RequestInit];
      expect(url).not.toContain('SECRET');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
      expect(await used()).toBe(1);

      // The same listing reloaded: no second call, no second credit.
      expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual(answer);
      expect(visionCalls(fetchMock)).toHaveLength(1);
      expect(await used()).toBe(1);
      vi.unstubAllGlobals();
    });

    it('forgets a refused key when the key tests fine in the options page', async () => {
      let vision = billingOff;
      const fetchMock = stubWeb(() => vision());
      await saveSettings({ keys: { vision: KEY } });
      const send = start();
      const other = 'https://images1.vinted.net/t/2/f800/b.webp';

      const refused = { status: 'error', reason: 'billing' };
      expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual(refused);
      expect(await send({ type: 'searchImage', photoUrl: other }, fromPage)).toEqual(refused);
      expect(visionCalls(fetchMock)).toHaveLength(1);

      // The user fixes the project and tests the key in the options page.
      vision = () => Response.json({});
      expect(await send({ type: 'testKey', provider: 'vision', key: KEY }, fromOptions)).toEqual({
        ok: true,
      });
      vision = () => Response.json(FOUND);
      const probes = visionCalls(fetchMock).length;
      expect(
        (await send({ type: 'searchImage', photoUrl: other }, fromPage)) as { status: string },
      ).toMatchObject({ status: 'ok' });
      expect(visionCalls(fetchMock)).toHaveLength(probes + 1);
      vi.unstubAllGlobals();
    });

    it('forgets a refused key when the stored key changes, even back to the same one', async () => {
      const fetchMock = stubWeb(billingOff);
      await saveSettings({ keys: { vision: KEY } });
      const send = start();
      const photo = (n: number) => `https://images1.vinted.net/t/${n}/f800/p.webp`;

      await send({ type: 'searchImage', photoUrl: photo(1) }, fromPage);
      await send({ type: 'searchImage', photoUrl: photo(2) }, fromPage);
      expect(visionCalls(fetchMock)).toHaveLength(1);

      // Another key, then the first one again: the refusal is no longer remembered.
      await saveSettings({ keys: { vision: `${KEY}x` } });
      await saveSettings({ keys: { vision: KEY } });
      await send({ type: 'searchImage', photoUrl: photo(3) }, fromPage);
      expect(visionCalls(fetchMock)).toHaveLength(2);

      // Saving something else leaves the memory alone.
      await saveSettings({ mode: 'click' });
      await send({ type: 'searchImage', photoUrl: photo(4) }, fromPage);
      expect(visionCalls(fetchMock)).toHaveLength(2);
      vi.unstubAllGlobals();
    });
  });

  describe('aiReview', () => {
    const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
    const INPUT = {
      photoUrl: PHOTO,
      title: 'Robe de soirée',
      description: 'Robe portée une fois.',
      price: '12,50 €',
      signals: ['La photo est identique à celle d’articles vendus sur Shein.'],
    };
    // The background remembers a refused key in memory across tests: each test gets its own key.
    let KEY = '';
    let keyCount = 0;
    beforeEach(() => {
      KEY = `AIzaSECRETSECRETSECRETSECRETSECRET${String(++keyCount).padStart(4, '0')}`;
    });
    const GOOD = {
      candidates: [
        {
          content: {
            parts: [{ text: '{"catalogPhoto":true,"summary":"La photo vient de Shein."}' }],
          },
        },
      ],
    };

    /** The Vinted CDN answers with a few bytes, Gemini with `geminiAnswer`. */
    function stubWeb(geminiAnswer: () => Response) {
      const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((url) =>
        Promise.resolve(
          String(url).startsWith('https://generativelanguage.googleapis.com/')
            ? geminiAnswer()
            : new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { 'content-type': 'image/webp' },
              }),
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }
    const billingOff = () =>
      Response.json(
        {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'This API method requires billing to be enabled.',
          },
        },
        { status: 403 },
      );
    const geminiCalls = (fetchMock: ReturnType<typeof stubWeb>) =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('generativelanguage.googleapis'));
    const used = async () => (await getUsage('gemini', null)).used;

    it('reviews the listing with the saved key, spends one credit and answers with the review only', async () => {
      const fetchMock = stubWeb(() => Response.json(GOOD));
      await saveSettings({ keys: { gemini: KEY } });
      const send = start();

      const answer = await send({ type: 'aiReview', input: INPUT }, fromPage);
      expect(answer).toEqual({
        status: 'ok',
        review: { catalogPhoto: true, summary: 'La photo vient de Shein.' },
      });
      expect(JSON.stringify(answer)).not.toContain('SECRET');

      const calls = geminiCalls(fetchMock);
      expect(calls).toHaveLength(1);
      const [url, init] = calls[0] as [string, RequestInit];
      expect(url).not.toContain('SECRET');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
      // The photo travels as base64, the listing as text; the key is in the header only.
      expect(String(init.body)).toContain('AQID');
      expect(String(init.body)).toContain('Robe de soirée');
      expect(String(init.body)).not.toContain(KEY);
      expect(await used()).toBe(1);
      expect((await getUsage('vision', null)).used).toBe(0);

      // The same listing reloaded: no second call, no second credit.
      expect(await send({ type: 'aiReview', input: INPUT }, fromPage)).toEqual(answer);
      expect(geminiCalls(fetchMock)).toHaveLength(1);
      expect(await used()).toBe(1);
      vi.unstubAllGlobals();
    });

    it('only looks in the cache when asked to, and spends nothing', async () => {
      const fetchMock = stubWeb(() => Response.json(GOOD));
      await saveSettings({ keys: { gemini: KEY } });
      const send = start();

      expect(await send({ type: 'aiReview', input: INPUT, cacheOnly: true }, fromPage)).toEqual({
        status: 'not_cached',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await used()).toBe(0);
      vi.unstubAllGlobals();
    });

    it('answers no_key without a Gemini key, whatever the Vision key', async () => {
      const fetchMock = stubWeb(() => Response.json(GOOD));
      await saveSettings({ keys: { vision: KEY } });
      const send = start();

      expect(await send({ type: 'aiReview', input: INPUT }, fromPage)).toEqual({
        status: 'no_key',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('forgets a refused key when the key tests fine in the options page', async () => {
      let gemini = billingOff;
      const fetchMock = stubWeb(() => gemini());
      await saveSettings({ keys: { gemini: KEY } });
      const send = start();
      const other = { ...INPUT, price: '99,00 €' };

      const refused = { status: 'error', reason: 'billing' };
      expect(await send({ type: 'aiReview', input: INPUT }, fromPage)).toEqual(refused);
      expect(await send({ type: 'aiReview', input: other }, fromPage)).toEqual(refused);
      expect(geminiCalls(fetchMock)).toHaveLength(1);
      // Google said no without billing: the credit came back.
      expect(await used()).toBe(0);

      // The user fixes the project and tests the key in the options page.
      gemini = () => Response.json({});
      expect(await send({ type: 'testKey', provider: 'gemini', key: KEY }, fromOptions)).toEqual({
        ok: true,
      });
      gemini = () => Response.json(GOOD);
      const probes = geminiCalls(fetchMock).length;
      expect(
        (await send({ type: 'aiReview', input: other }, fromPage)) as { status: string },
      ).toMatchObject({ status: 'ok' });
      expect(geminiCalls(fetchMock)).toHaveLength(probes + 1);
      vi.unstubAllGlobals();
    });

    it('forgets a refused key when the stored key changes, even back to the same one', async () => {
      const fetchMock = stubWeb(billingOff);
      await saveSettings({ keys: { gemini: KEY } });
      const send = start();
      const listing = (n: number) => ({ ...INPUT, price: `${n} €` });

      await send({ type: 'aiReview', input: listing(1) }, fromPage);
      await send({ type: 'aiReview', input: listing(2) }, fromPage);
      expect(geminiCalls(fetchMock)).toHaveLength(1);

      // Another key, then the first one again: the refusal is no longer remembered.
      await saveSettings({ keys: { gemini: `${KEY}x` } });
      await saveSettings({ keys: { gemini: KEY } });
      await send({ type: 'aiReview', input: listing(3) }, fromPage);
      expect(geminiCalls(fetchMock)).toHaveLength(2);

      // Saving something else, or the other provider's key, leaves the memory alone.
      await saveSettings({ mode: 'click' });
      await saveSettings({ keys: { vision: 'AIzaVision' } });
      await send({ type: 'aiReview', input: listing(4) }, fromPage);
      expect(geminiCalls(fetchMock)).toHaveLength(2);
      vi.unstubAllGlobals();
    });

    it('keeps the two providers apart: a Vision key tested fine does not forget a Gemini refusal', async () => {
      const fetchMock = stubWeb(billingOff);
      await saveSettings({ keys: { gemini: KEY } });
      const send = start();

      await send({ type: 'aiReview', input: INPUT }, fromPage);
      await send({ type: 'aiReview', input: { ...INPUT, price: '1 €' } }, fromPage);
      expect(geminiCalls(fetchMock)).toHaveLength(1);

      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
      );
      await send({ type: 'testKey', provider: 'vision', key: 'AIzaVision' }, fromOptions);
      vi.stubGlobal('fetch', fetchMock);
      await send({ type: 'aiReview', input: { ...INPUT, price: '2 €' } }, fromPage);
      expect(geminiCalls(fetchMock)).toHaveLength(1);
      vi.unstubAllGlobals();
    });
  });

  describe('options page', () => {
    it('opens the options page, asking it for the requested section', async () => {
      const open = vi
        .spyOn(browser.runtime, 'openOptionsPage')
        .mockResolvedValue(undefined as never);
      const create = vi.spyOn(browser.tabs, 'create');
      const send = start();

      await send({ type: 'openOptions', section: 'guide' }, fromPage);
      expect(open).toHaveBeenCalledOnce();
      expect(await pending()).toBe('guide');
      // The existing tab is reused: no new tab is created behind its back.
      expect(create).not.toHaveBeenCalled();
    });

    it('replaces a stale request when none is made', async () => {
      vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
      await browser.storage.session.set({ [PENDING_SECTION_KEY]: 'credits' });
      const send = start();
      await send({ type: 'openOptions' }, fromPage);
      expect(await pending()).toBeUndefined();
    });

    it('opens the options page when the toolbar button is clicked', async () => {
      const open = vi
        .spyOn(browser.runtime, 'openOptionsPage')
        .mockResolvedValue(undefined as never);
      let clicked: (() => void) | undefined;
      vi.spyOn(browser.action.onClicked, 'addListener').mockImplementation(((fn: () => void) => {
        clicked = fn;
      }) as never);
      start();
      clicked?.();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(await pending()).toBeUndefined();
    });

    it('welcomes a new install, and only a new install', async () => {
      const open = vi
        .spyOn(browser.runtime, 'openOptionsPage')
        .mockResolvedValue(undefined as never);
      let installed: ((details: { reason: string }) => void) | undefined;
      vi.spyOn(browser.runtime.onInstalled, 'addListener').mockImplementation(((
        fn: (details: { reason: string }) => void,
      ) => {
        installed = fn;
      }) as never);
      start();
      installed?.({ reason: 'update' });
      installed?.({ reason: 'browser_update' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(open).not.toHaveBeenCalled();

      installed?.({ reason: 'install' });
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(await pending()).toBe('welcome');
    });
  });
});

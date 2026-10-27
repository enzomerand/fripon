import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../entrypoints/background';
import { CLOUD_ORIGIN } from '../lib/cloud/config';
import { SESSION_KEY, STATUS_KEY, loadSession, saveSession } from '../lib/cloud/session';
import { PLAN_USAGE } from '../lib/cloud/test-helpers';
import { getUsage } from '../lib/credits';
import { PENDING_SECTION_KEY } from '../lib/options-nav';
import { saveSettings } from '../lib/settings';

type Sender = { id?: string; url?: string; tab?: { id?: number }; frameId?: number };
type Listener = (
  message: unknown,
  sender: Sender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

const ORIGIN = browser.runtime.getURL('/');
const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';
const TOKEN = 'cloud-token-SECRET-0123456789';
const MATCHES = [
  { platform: 'Shein', url: 'https://fr.shein.com/Robe-p-1.html', exact: true, price: null },
];

const fromPage = { id: browser.runtime.id, url: 'https://www.vinted.fr/items/1-robe' };
const fromOptions = { id: browser.runtime.id, url: `${ORIGIN}options.html` };
const fromTab = { ...fromPage, tab: { id: 4 } };

function start() {
  let listener: Listener | undefined;
  vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(((fn: Listener) => {
    listener = fn;
  }) as never);
  background.main();
  if (!listener) throw new Error('no onMessage listener registered');
  const registered = listener;
  return (message: unknown, sender: Sender) =>
    new Promise<unknown>((resolve) => {
      if (!registered(message, sender, resolve)) resolve('no answer');
    });
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The Fripon server, the Vinted CDN and Google: only the first should be called when signed in. */
function stubWorld(
  options: { search?: () => Response; me?: () => Response; review?: () => Response } = {},
) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((url) => {
    const target = String(url);
    if (target === `${CLOUD_ORIGIN}/v1/auth/code`) return Promise.resolve(json(204));
    if (target === `${CLOUD_ORIGIN}/v1/auth/verify`) {
      return Promise.resolve(json(200, { token: TOKEN }));
    }
    if (target === `${CLOUD_ORIGIN}/v1/auth/logout`) return Promise.resolve(json(204));
    if (target === `${CLOUD_ORIGIN}/v1/me`) {
      return Promise.resolve(
        options.me?.() ?? json(200, { email: 'a@b.fr', ...PLAN_USAGE, subscription: null }),
      );
    }
    if (target === `${CLOUD_ORIGIN}/v1/search`) {
      return Promise.resolve(
        options.search?.() ?? json(200, { matches: MATCHES, charged: true, usage: PLAN_USAGE }),
      );
    }
    if (target === `${CLOUD_ORIGIN}/v1/review`) {
      return Promise.resolve(
        options.review?.() ??
          json(200, { review: { catalogPhoto: true, summary: 'Photo de catalogue.' } }),
      );
    }
    if (target === `${CLOUD_ORIGIN}/v1/billing/checkout`) {
      return Promise.resolve(json(200, { url: 'https://checkout.stripe.com/c/pay/x' }));
    }
    return Promise.resolve(new Response('unexpected', { status: 500 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof stubWorld>, path: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url) === `${CLOUD_ORIGIN}${path}`);

const REVIEW_INPUT = {
  photoUrl: PHOTO,
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: ['Recherche d’image : trouvée.'],
  fingerprint: ['image:exact'],
};

// The background keeps the time of its last read of the account in memory, across tests: every
// test starts an hour later than the one before.
let hour = 0;

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 27, ++hour));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the background, signed out', () => {
  it('behaves as before: the gates come from the personal keys, nothing goes to the server', async () => {
    const fetchMock = stubWorld();
    const send = start();
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'no_key', ai: 'no_key' });
    expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual({
      status: 'no_key',
    });
    expect(await send({ type: 'aiReview', input: REVIEW_INPUT }, fromPage)).toEqual({
      status: 'no_key',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leads the card buttons to the options sections they name', async () => {
    vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    const send = start();
    await send({ type: 'openOptions', section: 'credits' }, fromPage);
    expect((await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY]).toBe(
      'credits',
    );
  });
});

describe('signing in from the options page', () => {
  it('asks for a code, then signs in, and the gates follow the account', async () => {
    const fetchMock = stubWorld();
    const send = start();
    expect(await send({ type: 'cloudRequestCode', email: 'A@B.fr' }, fromOptions)).toEqual({
      ok: true,
    });
    expect(JSON.parse(String(callsTo(fetchMock, '/v1/auth/code')[0]?.[1].body))).toEqual({
      email: 'a@b.fr',
    });

    expect(
      await send({ type: 'cloudVerify', email: 'a@b.fr', code: '123456' }, fromOptions),
    ).toEqual({ ok: true });
    expect((await loadSession())?.token).toBe(TOKEN);

    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'ready', ai: 'ready' });
    await saveSettings({ mode: 'click' });
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'manual', ai: 'manual' });
    expect(await send({ type: 'getVisionUsage' }, fromPage)).toEqual({ remaining: 288 });
  });

  it('never lets the token out: not in an answer, not in the status', async () => {
    stubWorld();
    const send = start();
    const answers = [
      await send({ type: 'cloudVerify', email: 'a@b.fr', code: '123456' }, fromOptions),
      await send({ type: 'cloudStatus' }, fromOptions),
      await send({ type: 'getGates' }, fromPage),
      await send({ type: 'getVisionUsage' }, fromPage),
      await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage),
    ];
    expect(JSON.stringify(answers)).not.toContain('SECRET');
    const stored = await browser.storage.local.get(STATUS_KEY);
    expect(JSON.stringify(stored)).not.toContain('SECRET');
    expect(JSON.stringify(await browser.storage.local.get(SESSION_KEY))).toContain('SECRET');
  });

  it('refuses every cloud message from a content script', async () => {
    const fetchMock = stubWorld();
    await saveSession({ token: TOKEN, email: 'a@b.fr' });
    const send = start();
    const messages = [
      { type: 'cloudStatus' },
      { type: 'cloudRequestCode', email: 'a@b.fr' },
      { type: 'cloudVerify', email: 'a@b.fr', code: '123456' },
      { type: 'cloudSignOut' },
      { type: 'cloudCheckout', price: 'essentiel_monthly' },
      { type: 'cloudPortal' },
    ];
    for (const message of messages) {
      expect(await send(message, fromPage)).toBe('no answer');
      expect(await send(message, fromTab)).toBe('no answer');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await loadSession())?.token).toBe(TOKEN);
  });
});

describe('the background, signed in', () => {
  beforeEach(async () => {
    await saveSession({ token: TOKEN, email: 'a@b.fr' });
  });

  it('runs the image search at the server, with the token, and never at Google', async () => {
    const fetchMock = stubWorld();
    const send = start();
    expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual({
      status: 'ok',
      matches: MATCHES,
    });
    const [call] = callsTo(fetchMock, '/v1/search');
    expect((call?.[1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(call?.[1].body))).toEqual({ photoUrl: PHOTO });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('googleapis.com'))).toBe(
      false,
    );
    // The personal counters are not touched.
    expect((await getUsage('vision', null)).used).toBe(0);
  });

  it('uses no personal key, even a saved one, and falls back to none', async () => {
    await saveSettings({ keys: { vision: 'AIzaVISIONKEY', gemini: 'AIzaGEMINIKEY' } });
    const fetchMock = stubWorld({ search: () => json(402, { error: 'quota', reason: 'month' }) });
    const send = start();
    expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual({
      status: 'quota',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('googleapis.com'))).toBe(
      false,
    );
  });

  it('runs the AI review at the server', async () => {
    const fetchMock = stubWorld();
    const send = start();
    expect(await send({ type: 'aiReview', input: REVIEW_INPUT }, fromPage)).toEqual({
      status: 'ok',
      review: { catalogPhoto: true, summary: 'Photo de catalogue.' },
    });
    expect(callsTo(fetchMock, '/v1/review')).toHaveLength(1);
  });

  it('turns the gates to quota once the day is used up', async () => {
    stubWorld({
      me: () =>
        json(200, {
          email: 'a@b.fr',
          ...PLAN_USAGE,
          day: { used: 40, cap: 40 },
          subscription: null,
        }),
    });
    const send = start();
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'quota', ai: 'quota' });
  });

  it('leads the card buttons for keys and credits to the subscription', async () => {
    vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined as never);
    const send = start();
    for (const section of ['credits', 'keys', 'guide']) {
      await send({ type: 'openOptions', section }, fromPage);
      expect((await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY]).toBe(
        'cloud',
      );
    }
    await send({ type: 'openOptions' }, fromPage);
    expect(
      (await browser.storage.session.get(PENDING_SECTION_KEY))[PENDING_SECTION_KEY],
    ).toBeUndefined();
  });

  it('opens Stripe Checkout in a new tab', async () => {
    const fetchMock = stubWorld();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const send = start();
    expect(await send({ type: 'cloudCheckout', price: 'revendeur_monthly' }, fromOptions)).toEqual({
      ok: true,
    });
    expect(JSON.parse(String(callsTo(fetchMock, '/v1/billing/checkout')[0]?.[1].body))).toEqual({
      price: 'revendeur_monthly',
    });
    expect(create).toHaveBeenCalledWith({ url: 'https://checkout.stripe.com/c/pay/x' });
  });

  it('signs out: the server is told, and the personal keys are back at once', async () => {
    const fetchMock = stubWorld();
    const send = start();
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'ready', ai: 'ready' });
    await send({ type: 'cloudSignOut' }, fromOptions);
    expect(await loadSession()).toBeNull();
    expect(callsTo(fetchMock, '/v1/auth/logout')).toHaveLength(1);
    expect(await send({ type: 'getGates' }, fromPage)).toEqual({ image: 'no_key', ai: 'no_key' });
    expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual({
      status: 'no_key',
    });
  });

  it('is signed out when the server refuses the token', async () => {
    stubWorld({ search: () => json(401, { error: 'unauthorized' }) });
    const send = start();
    expect(await send({ type: 'searchImage', photoUrl: PHOTO }, fromPage)).toEqual({
      status: 'no_key',
    });
    expect(await loadSession()).toBeNull();
  });
});

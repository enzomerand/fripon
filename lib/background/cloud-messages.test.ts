import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_PAGE_ONLY, isRuntimeMessage, OPTIONS_SECTIONS } from '../messages';
import type { RuntimeMessage } from '../messages';
import { handleMessage, isAllowedSender, type BackgroundDeps } from './handlers';

const own = { id: 'abc', origin: 'chrome-extension://abc/' };
const vintedPage = 'https://www.vinted.fr/items/1-robe';
const optionsPage = 'chrome-extension://abc/options.html#cloud';

const CLOUD_MESSAGES: RuntimeMessage[] = [
  { type: 'cloudStatus' },
  { type: 'cloudRequestCode', email: 'a@b.fr' },
  { type: 'cloudVerify', email: 'a@b.fr', code: '123456' },
  { type: 'cloudSignOut' },
  { type: 'cloudCheckout', price: 'essentiel_monthly' },
  { type: 'cloudPortal' },
];

describe('the cloud messages, as the background reads them', () => {
  it('accepts the well-formed ones', () => {
    for (const message of CLOUD_MESSAGES) expect(isRuntimeMessage(message)).toBe(true);
    for (const price of ['essentiel_monthly', 'essentiel_yearly', 'revendeur_monthly']) {
      expect(isRuntimeMessage({ type: 'cloudCheckout', price })).toBe(true);
    }
  });

  it('refuses an address that is missing, blank, not text or absurdly long', () => {
    for (const email of [undefined, '', '   ', 5, null, 'a'.repeat(255)]) {
      expect(isRuntimeMessage({ type: 'cloudRequestCode', email })).toBe(false);
      expect(isRuntimeMessage({ type: 'cloudVerify', email, code: '123456' })).toBe(false);
    }
  });

  it('refuses a code that is missing, not text or too long to be one', () => {
    for (const code of [undefined, 123456, null, '1'.repeat(17)]) {
      expect(isRuntimeMessage({ type: 'cloudVerify', email: 'a@b.fr', code })).toBe(false);
    }
  });

  it('refuses a price that is not one of the three on sale', () => {
    for (const price of [undefined, '', 'essentiel', 'free', 3, 'revendeur_yearly']) {
      expect(isRuntimeMessage({ type: 'cloudCheckout', price })).toBe(false);
    }
  });

  it('knows the cloud section of the options page', () => {
    expect(OPTIONS_SECTIONS).toContain('cloud');
    expect(isRuntimeMessage({ type: 'openOptions', section: 'cloud' })).toBe(true);
    expect(isRuntimeMessage({ type: 'openOptions', section: 'billing' })).toBe(false);
  });
});

describe('who may send a cloud message', () => {
  it('lists every one of them as extension-page only', () => {
    for (const { type } of CLOUD_MESSAGES) expect(EXTENSION_PAGE_ONLY).toContain(type);
  });

  it('lets only the options page of this extension send them', () => {
    for (const message of CLOUD_MESSAGES) {
      expect(isAllowedSender(message, { id: 'abc', url: optionsPage }, own), message.type).toBe(
        true,
      );
    }
  });

  it('refuses a content script, in any frame and any tab', () => {
    for (const message of CLOUD_MESSAGES) {
      for (const sender of [
        { id: 'abc', url: vintedPage },
        { id: 'abc', url: vintedPage, tab: { id: 4 } },
        { id: 'abc', url: vintedPage, tab: { id: 4 }, frameId: 3 },
        { id: 'abc', url: 'https://evil.example/', tab: { id: 9 } },
      ]) {
        expect(isAllowedSender(message, sender, own), message.type).toBe(false);
      }
    }
  });

  it('refuses a sender without an address, another extension, and a lookalike origin', () => {
    for (const message of CLOUD_MESSAGES) {
      expect(isAllowedSender(message, { id: 'abc' }, own), message.type).toBe(false);
      expect(isAllowedSender(message, { id: 'other', url: optionsPage }, own)).toBe(false);
      expect(isAllowedSender(message, { url: optionsPage }, own)).toBe(false);
      expect(
        isAllowedSender(
          message,
          { id: 'abc', url: 'chrome-extension://abc.evil/options.html' },
          own,
        ),
      ).toBe(false);
    }
  });
});

function makeDeps(cloud: Partial<BackgroundDeps['cloud']> = {}): BackgroundDeps {
  return {
    analyzeImage: vi.fn(),
    searchImage: vi.fn(),
    aiReview: vi.fn(),
    loadGates: vi.fn(),
    loadVisionRemaining: vi.fn(),
    checkKey: vi.fn(),
    openOptions: vi.fn(),
    setBadge: vi.fn(),
    cloud: {
      status: vi.fn(() => Promise.resolve(null)),
      requestCode: vi.fn(() => Promise.resolve({ ok: true as const })),
      verify: vi.fn(() => Promise.resolve({ ok: true as const })),
      signOut: vi.fn(() => Promise.resolve()),
      checkout: vi.fn(() => Promise.resolve({ ok: true as const })),
      portal: vi.fn(() => Promise.resolve({ ok: true as const })),
      ...cloud,
    },
  };
}

describe('handling the cloud messages', () => {
  it('hands each one to the account with its payload', async () => {
    const deps = makeDeps();
    await handleMessage({ type: 'cloudStatus' }, deps);
    await handleMessage({ type: 'cloudRequestCode', email: 'a@b.fr' }, deps);
    await handleMessage({ type: 'cloudVerify', email: 'a@b.fr', code: '123456' }, deps);
    await handleMessage({ type: 'cloudSignOut' }, deps);
    await handleMessage({ type: 'cloudCheckout', price: 'essentiel_yearly' }, deps);
    await handleMessage({ type: 'cloudPortal' }, deps);
    expect(deps.cloud.status).toHaveBeenCalledOnce();
    expect(deps.cloud.requestCode).toHaveBeenCalledWith('a@b.fr');
    expect(deps.cloud.verify).toHaveBeenCalledWith('a@b.fr', '123456');
    expect(deps.cloud.signOut).toHaveBeenCalledOnce();
    expect(deps.cloud.checkout).toHaveBeenCalledWith('essentiel_yearly');
    expect(deps.cloud.portal).toHaveBeenCalledOnce();
  });

  it('answers what the account answers', async () => {
    const status = { email: 'a@b.fr', usage: null, subscription: null, checkedAt: 0 };
    const deps = makeDeps({
      status: vi.fn(() => Promise.resolve(status)),
      requestCode: vi.fn(() =>
        Promise.resolve({ ok: false as const, reason: 'rate_limited' as const }),
      ),
    });
    expect(await handleMessage({ type: 'cloudStatus' }, deps)).toEqual(status);
    expect(await handleMessage({ type: 'cloudRequestCode', email: 'a@b.fr' }, deps)).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
  });

  it('never rejects: a failing account reads as signed out, or as no network', async () => {
    const boom = () => Promise.reject(new Error('storage'));
    const deps = makeDeps({
      status: vi.fn(boom),
      requestCode: vi.fn(boom),
      verify: vi.fn(boom),
      signOut: vi.fn(boom),
      checkout: vi.fn(boom),
      portal: vi.fn(boom),
    });
    expect(await handleMessage({ type: 'cloudStatus' }, deps)).toBeNull();
    expect(await handleMessage({ type: 'cloudRequestCode', email: 'a@b.fr' }, deps)).toEqual({
      ok: false,
      reason: 'network',
    });
    expect(
      await handleMessage({ type: 'cloudVerify', email: 'a@b.fr', code: '123456' }, deps),
    ).toEqual({ ok: false, reason: 'network' });
    expect(await handleMessage({ type: 'cloudSignOut' }, deps)).toBeUndefined();
    expect(
      await handleMessage({ type: 'cloudCheckout', price: 'essentiel_monthly' }, deps),
    ).toEqual({ ok: false, reason: 'network' });
    expect(await handleMessage({ type: 'cloudPortal' }, deps)).toEqual({
      ok: false,
      reason: 'network',
    });
  });
});

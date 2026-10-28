import { describe, expect, it, vi } from 'vitest';
import type { AiReviewInput } from '../ai/input';
import { createRouter, sectionFor, type PaidSteps } from './router';
import type { SessionState } from './session';

const INPUT = {
  photoUrl: 'https://images1.vinted.net/a.jpg',
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: [],
  fingerprint: [],
} satisfies AiReviewInput;

function steps(name: string): PaidSteps {
  return {
    searchImage: vi.fn(() => Promise.resolve({ status: 'ok' as const, matches: [] })),
    aiReview: vi.fn(() =>
      Promise.resolve({ status: 'ok' as const, review: { catalogPhoto: false, summary: name } }),
    ),
    loadGates: vi.fn(() =>
      Promise.resolve(
        name === 'cloud'
          ? { image: 'ready' as const, ai: 'ready' as const }
          : { image: 'no_key' as const, ai: 'no_key' as const },
      ),
    ),
    loadVisionRemaining: vi.fn(() => Promise.resolve(name === 'cloud' ? 288 : 640)),
  };
}

function setup(sessionState: () => Promise<SessionState>) {
  const cloud = steps('cloud');
  const personal = steps('personal');
  return { cloud, personal, router: createRouter({ sessionState, cloud, personal }) };
}

const IN = () => Promise.resolve<SessionState>('signed_in');
const OUT = () => Promise.resolve<SessionState>('signed_out');
const EXPIRED = () => Promise.resolve<SessionState>('expired');

describe('the router', () => {
  it('sends every paid step to the subscription when signed in, and nothing to the keys', async () => {
    const { router, cloud, personal } = setup(IN);
    await router.searchImage('https://images1.vinted.net/a.jpg', false, true);
    await router.aiReview(INPUT, true, false);
    expect(await router.loadGates()).toEqual({ image: 'ready', ai: 'ready' });
    expect(await router.loadVisionRemaining()).toBe(288);

    expect(cloud.searchImage).toHaveBeenCalledWith('https://images1.vinted.net/a.jpg', false, true);
    expect(cloud.aiReview).toHaveBeenCalledWith(INPUT, true, false);
    for (const fn of Object.values(personal)) expect(fn).not.toHaveBeenCalled();
  });

  it('sends every paid step to the personal keys when signed out, and nothing to the server', async () => {
    const { router, cloud, personal } = setup(OUT);
    await router.searchImage('https://images1.vinted.net/a.jpg', true, false);
    await router.aiReview(INPUT, false, true);
    expect(await router.loadGates()).toEqual({ image: 'no_key', ai: 'no_key' });
    expect(await router.loadVisionRemaining()).toBe(640);

    expect(personal.searchImage).toHaveBeenCalledWith(
      'https://images1.vinted.net/a.jpg',
      true,
      false,
    );
    expect(personal.aiReview).toHaveBeenCalledWith(INPUT, false, true);
    for (const fn of Object.values(cloud)) expect(fn).not.toHaveBeenCalled();
  });

  it('looks at the session at every call: a sign-in or sign-out takes effect at once', async () => {
    let state: SessionState = 'signed_out';
    const { router, cloud, personal } = setup(() => Promise.resolve(state));
    await router.loadGates();
    state = 'signed_in';
    await router.loadGates();
    state = 'signed_out';
    await router.loadGates();
    expect(personal.loadGates).toHaveBeenCalledTimes(2);
    expect(cloud.loadGates).toHaveBeenCalledTimes(1);
  });

  it('takes a session that cannot be read for no session', async () => {
    const { router, cloud, personal } = setup(() => Promise.reject(new Error('storage')));
    await router.loadGates();
    expect(personal.loadGates).toHaveBeenCalledTimes(1);
    expect(cloud.loadGates).not.toHaveBeenCalled();
  });
});

describe('the router once the session expired', () => {
  it('works from the personal keys, and never asks the server', async () => {
    const { router, cloud, personal } = setup(EXPIRED);
    await router.searchImage('https://images1.vinted.net/a.jpg', true, false);
    await router.aiReview(INPUT, false, true);
    expect(await router.loadVisionRemaining()).toBe(640);
    expect(personal.searchImage).toHaveBeenCalledOnce();
    expect(personal.aiReview).toHaveBeenCalledOnce();
    for (const fn of Object.values(cloud)) expect(fn).not.toHaveBeenCalled();
  });

  it('says expired where there would be no key, so no card asks for a Google key', async () => {
    const { router, personal } = setup(EXPIRED);
    vi.mocked(personal.searchImage).mockResolvedValue({ status: 'no_key' });
    vi.mocked(personal.aiReview).mockResolvedValue({ status: 'no_key' });
    expect(await router.loadGates()).toEqual({ image: 'expired', ai: 'expired' });
    expect(await router.searchImage('https://images1.vinted.net/a.jpg', false, false)).toEqual({
      status: 'expired',
    });
    expect(await router.aiReview(INPUT, false, false)).toEqual({ status: 'expired' });
  });

  it('leaves every other answer alone, a key the user kept included', async () => {
    const { router, personal } = setup(EXPIRED);
    vi.mocked(personal.loadGates).mockResolvedValue({ image: 'ready', ai: 'no_key' });
    expect(await router.loadGates()).toEqual({ image: 'ready', ai: 'expired' });
    vi.mocked(personal.loadGates).mockResolvedValue({ image: 'quota', ai: 'manual' });
    expect(await router.loadGates()).toEqual({ image: 'quota', ai: 'manual' });
    expect(
      (await router.searchImage('https://images1.vinted.net/a.jpg', false, false)).status,
    ).toBe('ok');
    vi.mocked(personal.searchImage).mockResolvedValue({ status: 'quota' });
    expect(await router.searchImage('https://images1.vinted.net/a.jpg', false, false)).toEqual({
      status: 'quota',
    });
  });

  it('says nothing of an expired session to someone who never had one', async () => {
    const { router, personal } = setup(OUT);
    vi.mocked(personal.searchImage).mockResolvedValue({ status: 'no_key' });
    expect(await router.searchImage('https://images1.vinted.net/a.jpg', false, false)).toEqual({
      status: 'no_key',
    });
  });
});

describe('sectionFor', () => {
  it('leads a subscriber, signed in or to sign in again, to the subscription instead of the keys, the credits or the guide', () => {
    for (const section of ['guide', 'keys', 'credits'] as const) {
      expect(sectionFor('signed_in', section)).toBe('cloud');
      expect(sectionFor('expired', section)).toBe('cloud');
      expect(sectionFor('signed_out', section)).toBe(section);
    }
  });

  it('leaves everything else alone', () => {
    for (const state of ['signed_in', 'expired'] as const) {
      expect(sectionFor(state, 'cloud')).toBe('cloud');
      expect(sectionFor(state, 'welcome')).toBe('welcome');
      expect(sectionFor(state, undefined)).toBeUndefined();
    }
    expect(sectionFor('signed_out', undefined)).toBeUndefined();
  });
});

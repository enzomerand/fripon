import { describe, expect, it, vi } from 'vitest';
import type { AiReviewInput } from '../ai/input';
import { createRouter, sectionFor, type PaidSteps } from './router';

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

function setup(signedIn: () => Promise<boolean>) {
  const cloud = steps('cloud');
  const personal = steps('personal');
  return { cloud, personal, router: createRouter({ signedIn, cloud, personal }) };
}

describe('the router', () => {
  it('sends every paid step to the subscription when signed in, and nothing to the keys', async () => {
    const { router, cloud, personal } = setup(() => Promise.resolve(true));
    await router.searchImage('https://images1.vinted.net/a.jpg', false, true);
    await router.aiReview(INPUT, true, false);
    expect(await router.loadGates()).toEqual({ image: 'ready', ai: 'ready' });
    expect(await router.loadVisionRemaining()).toBe(288);

    expect(cloud.searchImage).toHaveBeenCalledWith('https://images1.vinted.net/a.jpg', false, true);
    expect(cloud.aiReview).toHaveBeenCalledWith(INPUT, true, false);
    for (const fn of Object.values(personal)) expect(fn).not.toHaveBeenCalled();
  });

  it('sends every paid step to the personal keys when signed out, and nothing to the server', async () => {
    const { router, cloud, personal } = setup(() => Promise.resolve(false));
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
    let signedIn = false;
    const { router, cloud, personal } = setup(() => Promise.resolve(signedIn));
    await router.loadGates();
    signedIn = true;
    await router.loadGates();
    signedIn = false;
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

describe('sectionFor', () => {
  it('leads a signed-in account to its subscription instead of the keys, the credits or the guide', () => {
    for (const section of ['guide', 'keys', 'credits'] as const) {
      expect(sectionFor(true, section)).toBe('cloud');
      expect(sectionFor(false, section)).toBe(section);
    }
  });

  it('leaves everything else alone', () => {
    expect(sectionFor(true, 'cloud')).toBe('cloud');
    expect(sectionFor(true, 'welcome')).toBe('welcome');
    expect(sectionFor(true, undefined)).toBeUndefined();
    expect(sectionFor(false, undefined)).toBeUndefined();
  });
});

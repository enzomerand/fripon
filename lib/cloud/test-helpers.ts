import { vi } from 'vitest';
import type { AiReviewInput } from '../ai/input';
import type { CloudClient } from './client';
import type { CloudUsage } from './types';

/** An Essentiel account with room left. */
export const PLAN_USAGE: CloudUsage = {
  kind: 'plan',
  plan: 'essentiel',
  month: { used: 12, cap: 300 },
  day: { used: 3, cap: 40 },
  trialLeft: 15,
};

export const TRIAL_USAGE: CloudUsage = {
  kind: 'trial',
  month: { used: 5, cap: null },
  day: { used: 1, cap: null },
  trialLeft: 10,
};

/** A Vinted photo, as the card reads it. */
export const PHOTO = 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa';

/** What the card sends for an AI review of `PHOTO`. */
export const REVIEW_INPUT: AiReviewInput = {
  photoUrl: PHOTO,
  title: 'Robe',
  description: '',
  price: '12,00 €',
  signals: ['Recherche d’image : trouvée.'],
  fingerprint: ['image:exact'],
};

/** A JSON answer of the Fripon server, as `fetch` returns it. */
export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A client whose every call succeeds, each one a spy; override what a test cares about. */
export function makeClient(overrides: Partial<CloudClient> = {}): CloudClient {
  return {
    requestCode: vi.fn(() => Promise.resolve({ ok: true as const })),
    verify: vi.fn(() => Promise.resolve({ ok: true as const, token: 'tok-1' })),
    logout: vi.fn(() => Promise.resolve()),
    me: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        me: { email: 'a@b.fr', usage: PLAN_USAGE, subscription: null },
      }),
    ),
    search: vi.fn(() =>
      Promise.resolve({ ok: true as const, matches: [], charged: true, usage: PLAN_USAGE }),
    ),
    review: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        review: { catalogPhoto: false, summary: 'Rien de suspect.' },
      }),
    ),
    checkout: vi.fn(() =>
      Promise.resolve({ ok: true as const, url: 'https://checkout.stripe.com/c/pay/x' }),
    ),
    portal: vi.fn(() =>
      Promise.resolve({ ok: true as const, url: 'https://billing.stripe.com/p/session/x' }),
    ),
    deleteAccount: vi.fn(() => Promise.resolve({ ok: true as const })),
    ...overrides,
  };
}

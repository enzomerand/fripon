import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { GEMINI_MODEL, PROMPT_VERSION } from '../google/gemini';
import type { AiReview } from '../model';
import type { AiReviewInput } from './input';
import { AI_CACHE_TTL_MS, aiCacheKey, readAiCache, writeAiCache } from './review-cache';

// The model and the prompt version, as the cache key reads them: a test can change both.
const versions = vi.hoisted(() => ({ model: '', prompt: 0 }));
vi.mock('../google/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../google/gemini')>();
  versions.model = actual.GEMINI_MODEL;
  versions.prompt = actual.PROMPT_VERSION;
  return {
    ...actual,
    get GEMINI_MODEL() {
      return versions.model;
    },
    get PROMPT_VERSION() {
      return versions.prompt;
    },
  };
});

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const PHOTO = 'https://images1.vinted.net/t/01_abc/f800/123.webp?s=aa';
const INPUT: AiReviewInput = {
  photoUrl: PHOTO,
  title: 'Robe fleurie',
  description: 'Robe portée une fois.',
  price: '12,00 €',
  signals: ['Recherche d’image : non faite.', 'Vendeur (Normal) : 12 avis, 30 articles.'],
  fingerprint: ['Recherche d’image : non faite.', 'seller:ok:Normal'],
};
const REVIEW: AiReview = { catalogPhoto: true, summary: 'La photo vient de Shein.' };

beforeEach(() => {
  fakeBrowser.reset();
});

describe('aiCacheKey', () => {
  it('is the origin and the path of the photo, then a short hash, without the query string', () => {
    expect(aiCacheKey(PHOTO, INPUT)).toMatch(
      /^fripon:ai:v1:https:\/\/images1\.vinted\.net\/t\/01_abc\/f800\/123\.webp:[0-9a-f]{8}$/,
    );
  });

  it('is the same for the same picture with another signature', () => {
    expect(aiCacheKey(`${PHOTO}&x=1`, INPUT)).toBe(aiCacheKey(PHOTO, INPUT));
  });

  it('tells two pictures apart', () => {
    expect(aiCacheKey('https://images1.vinted.net/t/02/f800/a.webp', INPUT)).not.toBe(
      aiCacheKey('https://images1.vinted.net/t/03/f800/a.webp', INPUT),
    );
  });

  it('changes with the title, the price or what the checks found', () => {
    const key = aiCacheKey(PHOTO, INPUT);
    expect(aiCacheKey(PHOTO, { ...INPUT, title: 'Autre robe' })).not.toBe(key);
    expect(aiCacheKey(PHOTO, { ...INPUT, price: '10,00 €' })).not.toBe(key);
    expect(aiCacheKey(PHOTO, { ...INPUT, fingerprint: ['Autre résultat.'] })).not.toBe(key);
    expect(
      aiCacheKey(PHOTO, {
        ...INPUT,
        fingerprint: [...INPUT.fingerprint, 'photos:warn:Photo réutilisée'],
      }),
    ).not.toBe(key);
  });

  it('does not mix up where one part ends and the next begins', () => {
    expect(aiCacheKey(PHOTO, { ...INPUT, title: 'ab', price: 'c' })).not.toBe(
      aiCacheKey(PHOTO, { ...INPUT, title: 'a', price: 'bc' }),
    );
    expect(aiCacheKey(PHOTO, { ...INPUT, fingerprint: ['a', 'b'] })).not.toBe(
      aiCacheKey(PHOTO, { ...INPUT, fingerprint: ['ab'] }),
    );
  });

  it('ignores the description and the signal lines, whose counts move without changing the story', () => {
    const key = aiCacheKey(PHOTO, INPUT);
    expect(aiCacheKey(PHOTO, { ...INPUT, description: 'Tout autre texte.' })).toBe(key);
    expect(
      aiCacheKey(PHOTO, { ...INPUT, signals: ['Vendeur (Normal) : 13 avis, 31 articles.'] }),
    ).toBe(key);
    expect(aiCacheKey(PHOTO, { ...INPUT, signals: [] })).toBe(key);
  });

  describe('when the model or the question changes', () => {
    afterEach(() => {
      versions.model = GEMINI_MODEL;
      versions.prompt = PROMPT_VERSION;
    });

    it('is another key for another model', () => {
      const key = aiCacheKey(PHOTO, INPUT);
      versions.model = 'gemini-other-model';
      expect(aiCacheKey(PHOTO, INPUT)).not.toBe(key);
    });

    it('is another key for another version of the prompt', () => {
      const key = aiCacheKey(PHOTO, INPUT);
      versions.prompt = PROMPT_VERSION + 1;
      expect(aiCacheKey(PHOTO, INPUT)).not.toBe(key);
    });
  });
});

describe('readAiCache / writeAiCache', () => {
  it('gives back what was written, and stores nothing else than the review and the date', async () => {
    const key = aiCacheKey(PHOTO, INPUT);
    expect(await readAiCache(key, NOW)).toBeNull();

    await writeAiCache(key, REVIEW, NOW);
    expect(await readAiCache(key, NOW + 1000)).toEqual(REVIEW);
    expect((await browser.storage.local.get(key))[key]).toEqual({ review: REVIEW, at: NOW });
  });

  it('forgets a review after 7 days', async () => {
    const key = aiCacheKey(PHOTO, INPUT);
    await writeAiCache(key, REVIEW, NOW);
    expect(await readAiCache(key, NOW + AI_CACHE_TTL_MS)).toEqual(REVIEW);
    expect(await readAiCache(key, NOW + AI_CACHE_TTL_MS + 1)).toBeNull();
  });

  it.each([
    ['not an object', 'oops'],
    ['no review', { at: NOW }],
    ['no date', { review: REVIEW }],
    ['a date that is not finite', { review: REVIEW, at: Infinity }],
    [
      'a catalogPhoto that is not a boolean',
      { review: { catalogPhoto: 1, summary: 'Ok.' }, at: NOW },
    ],
    ['an empty summary', { review: { catalogPhoto: true, summary: '' }, at: NOW }],
    [
      'a summary that is too long',
      { review: { catalogPhoto: true, summary: 'a'.repeat(601) }, at: NOW },
    ],
  ])('treats an entry with %s as a miss', async (_name, entry) => {
    const key = aiCacheKey(PHOTO, INPUT);
    await browser.storage.local.set({ [key]: entry });
    expect(await readAiCache(key, NOW)).toBeNull();
  });
});

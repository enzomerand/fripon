import { describe, expect, it } from 'vitest';
import type { GeminiFailure } from '../google/gemini';
import type { AiReviewResponse } from '../messages';
import { aiBlockFor } from './block';

describe('aiBlockFor', () => {
  it('is the summary for a review', () => {
    expect(
      aiBlockFor({ status: 'ok', review: { catalogPhoto: true, summary: 'Photo de studio.' } }),
    ).toEqual({ status: 'done', summary: 'Photo de studio.' });
  });

  it('shows nothing at all without a key, and nothing for a look in the cache that found none', () => {
    expect(aiBlockFor({ status: 'no_key' })).toBeNull();
    // The image row above already asks to sign in again: one line, one button.
    expect(aiBlockFor({ status: 'expired' })).toBeNull();
    expect(aiBlockFor({ status: 'not_cached' })).toBeNull();
  });

  it('says the cap is reached, with no button', () => {
    expect(aiBlockFor({ status: 'quota' })).toEqual({
      status: 'failed',
      message: "Le plafond d'avis de l'IA est atteint pour aujourd'hui.",
    });
  });

  it('says the subscription has nothing left, whatever the period, and leads to it', () => {
    expect(aiBlockFor({ status: 'quota', source: 'cloud' })).toEqual({
      status: 'failed',
      message: "Tu n'as plus d'analyses disponibles.",
      action: 'open_cloud',
    });
    expect(JSON.stringify(aiBlockFor({ status: 'quota', source: 'cloud' }))).not.toContain(
      "aujourd'hui",
    );
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing'] as const)(
    'sends a "%s" key to the keys',
    (reason) => {
      expect(aiBlockFor({ status: 'error', reason })).toEqual({
        status: 'failed',
        message: 'Google refuse ta clé Gemini : vérifie-la dans les réglages.',
        action: 'open_keys',
      });
    },
  );

  it.each([
    ['quota', 'Google a atteint la limite de ta clé Gemini, réessaie plus tard.'],
    ['network', "L'IA ne répond pas pour l'instant."],
    ['photo', "L'IA n'a pas pu lire la photo de l'annonce."],
    ['unavailable', 'Gemini est indisponible pour le moment.'],
    ['invalid_answer', "L'IA a donné une réponse inutilisable."],
    ['review_limit', "Tu as déjà demandé 3 avis de l'IA pour cette annonce ce mois-ci."],
  ] as const)('gives one neutral line and no button for "%s"', (reason, message) => {
    expect(aiBlockFor({ status: 'error', reason })).toEqual({ status: 'failed', message });
  });

  it.each(['unavailable', 'network', 'photo', 'invalid_answer', 'review_limit'] as const)(
    'names no provider and no key when the failure comes from the subscription: "%s"',
    (reason) => {
      const block = aiBlockFor({ status: 'error', reason, source: 'cloud' });
      expect(block).toMatchObject({ status: 'failed' });
      expect(block).not.toHaveProperty('action');
      expect(JSON.stringify(block)).not.toMatch(/gemini|google|clé/i);
    },
  );

  it('words an unavailable subscription without Gemini, and keeps the personal key line as it was', () => {
    expect(aiBlockFor({ status: 'error', reason: 'unavailable', source: 'cloud' })).toEqual({
      status: 'failed',
      message: "L'IA est indisponible pour le moment.",
    });
    expect(aiBlockFor({ status: 'error', reason: 'unavailable' })).toEqual({
      status: 'failed',
      message: 'Gemini est indisponible pour le moment.',
    });
  });

  it('has a line for every failure there is', () => {
    const reasons: (GeminiFailure | 'review_limit')[] = [
      'invalid',
      'disabled',
      'restricted',
      'billing',
      'quota',
      'network',
      'photo',
      'unavailable',
      'invalid_answer',
      'review_limit',
    ];
    for (const reason of reasons) {
      const response: AiReviewResponse = { status: 'error', reason };
      const block = aiBlockFor(response);
      expect(block?.status).toBe('failed');
      expect(block && 'message' in block ? block.message : '').not.toBe('');
    }
  });
});

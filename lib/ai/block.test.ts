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
    expect(aiBlockFor({ status: 'not_cached' })).toBeNull();
  });

  it('says the cap is reached, with no button', () => {
    expect(aiBlockFor({ status: 'quota' })).toEqual({
      status: 'failed',
      message: "Le plafond d'avis de l'IA est atteint pour aujourd'hui.",
    });
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
    ['invalid_answer', "L'IA a donné une réponse inutilisable."],
  ] as const)('gives one neutral line and no button for "%s"', (reason, message) => {
    expect(aiBlockFor({ status: 'error', reason })).toEqual({ status: 'failed', message });
  });

  it('has a line for every failure there is', () => {
    const reasons: GeminiFailure[] = [
      'invalid',
      'disabled',
      'restricted',
      'billing',
      'quota',
      'network',
      'photo',
      'invalid_answer',
    ];
    for (const reason of reasons) {
      const response: AiReviewResponse = { status: 'error', reason };
      const block = aiBlockFor(response);
      expect(block?.status).toBe('failed');
      expect(block && 'message' in block ? block.message : '').not.toBe('');
    }
  });
});

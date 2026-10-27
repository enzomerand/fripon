import { describe, expect, it } from 'vitest';
import { REVIEW_LIMITS, clampReviewInput, isAiReviewInput, type AiReviewInput } from './input';

const INPUT: AiReviewInput = {
  photoUrl: 'https://images1.vinted.net/t/01_a/f800/main.webp?s=aa',
  title: 'Robe fleurie',
  description: 'Robe portée une fois.',
  price: '12,00 €',
  signals: ['Une ligne.', 'Une autre.'],
};

describe('isAiReviewInput', () => {
  it('accepts a well-formed input, with no signal or an empty description', () => {
    expect(isAiReviewInput(INPUT)).toBe(true);
    expect(isAiReviewInput({ ...INPUT, signals: [], description: '' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'input'],
    ['no photo URL', { ...INPUT, photoUrl: undefined }],
    ['a title that is not a string', { ...INPUT, title: 1 }],
    ['a description that is not a string', { ...INPUT, description: null }],
    ['a price that is not a string', { ...INPUT, price: 12 }],
    ['signals that are not a list', { ...INPUT, signals: 'one' }],
    ['a signal that is not a string', { ...INPUT, signals: ['one', 2] }],
  ])('refuses %s', (_name, value) => {
    expect(isAiReviewInput(value)).toBe(false);
  });
});

describe('clampReviewInput', () => {
  it('leaves an input within the limits as it is', () => {
    expect(clampReviewInput(INPUT)).toEqual(INPUT);
  });

  it('cuts every part to its limit', () => {
    const clamped = clampReviewInput({
      photoUrl: INPUT.photoUrl,
      title: 't'.repeat(REVIEW_LIMITS.title + 50),
      description: 'd'.repeat(REVIEW_LIMITS.description + 500),
      price: 'p'.repeat(REVIEW_LIMITS.price + 10),
      signals: Array.from({ length: REVIEW_LIMITS.signals + 5 }, () =>
        's'.repeat(REVIEW_LIMITS.signal + 100),
      ),
    });
    expect(clamped.title).toHaveLength(REVIEW_LIMITS.title);
    expect(clamped.description).toHaveLength(1_500);
    expect(clamped.price).toHaveLength(REVIEW_LIMITS.price);
    expect(clamped.signals).toHaveLength(REVIEW_LIMITS.signals);
    expect(clamped.signals.every((line) => line.length === REVIEW_LIMITS.signal)).toBe(true);
  });

  it('drops any field that is not part of the input', () => {
    const sneaky = { ...INPUT, apiKey: 'AIza', extra: [1] } as AiReviewInput;
    expect(Object.keys(clampReviewInput(sneaky)).sort()).toEqual([
      'description',
      'photoUrl',
      'price',
      'signals',
      'title',
    ]);
  });
});

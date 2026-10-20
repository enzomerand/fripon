import { describe, expect, it } from 'vitest';
import { priceCheckOff } from './price';

describe('priceCheckOff', () => {
  it('is an unavailable price row', () => {
    expect(priceCheckOff()).toEqual({
      id: 'price',
      status: 'off',
      tag: 'Indisponible',
      detail: "La comparaison de prix arrive avec la recherche d'image.",
      signals: [],
    });
  });
});

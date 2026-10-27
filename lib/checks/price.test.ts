import { describe, expect, it } from 'vitest';
import type { ImageMatch } from '../model';
import { PRICE_WITHOUT_MATCHES, PRICE_WITH_MATCHES, priceCheck } from './price';

const match = (exact: boolean): ImageMatch => ({
  platform: 'Shein',
  url: 'https://fr.shein.com/Robe-p-1.html',
  exact,
  price: null,
});

describe('priceCheck', () => {
  it('is a price row that was not compared, with nothing to compare to', () => {
    expect(priceCheck([])).toEqual({
      id: 'price',
      status: 'off',
      tag: 'Non comparé',
      detail: "Pas de prix d'origine à comparer.",
      signals: [],
    });
  });

  it('sends the buyer to the links above when the photo was found', () => {
    expect(priceCheck([match(true)])).toEqual({
      id: 'price',
      status: 'off',
      tag: 'Non comparé',
      detail:
        'Shein et Temu cachent leurs prix aux robots : compare toi-même avec les liens ci-dessus.',
      signals: [],
    });
    expect(PRICE_WITH_MATCHES).toBe(priceCheck([match(true)]).detail);
    expect(PRICE_WITHOUT_MATCHES).toBe(priceCheck([]).detail);
  });

  it('does the same for a lookalike: the image row links to it too', () => {
    expect(priceCheck([match(false)]).detail).toBe(PRICE_WITH_MATCHES);
  });

  it('never gives a signal, and never leaves the "off" status', () => {
    for (const matches of [[], [match(true)], [match(false), match(true)]]) {
      const row = priceCheck(matches);
      expect(row.signals).toEqual([]);
      expect(row.status).toBe('off');
    }
  });
});

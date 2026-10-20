import type { CheckResult } from '../model';

/** The price row until the full comparison ships (it needs the image search results). */
export function priceCheckOff(): CheckResult {
  return {
    id: 'price',
    status: 'off',
    tag: 'Indisponible',
    detail: "La comparaison de prix arrive avec la recherche d'image.",
    signals: [],
  };
}

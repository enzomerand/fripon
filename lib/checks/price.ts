import type { CheckResult } from '../model';

/** The price row until the comparison ships (it needs the original price of the image matches). */
export function priceCheckOff(): CheckResult {
  return {
    id: 'price',
    status: 'off',
    tag: 'Indisponible',
    detail: 'La comparaison de prix arrive dans une prochaine version de Fripon.',
    signals: [],
  };
}

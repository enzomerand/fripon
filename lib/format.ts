import type { Money } from './model';

/** "8,99 €" (fr-FR). Falls back to "8.99 XYZ" when the currency code is not valid ISO 4217. */
export function formatMoney(m: Money): string {
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: m.currency }).format(
      m.amount,
    );
  } catch {
    return `${m.amount} ${m.currency}`;
  }
}

/** "3,8" / "2": one decimal at most, French decimal comma. */
export function formatRatio(ratio: number): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(ratio);
}

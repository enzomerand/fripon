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

/** "12" / "1 000": an integer with the French thousands separator. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n);
}

/** "AIza••••••1234": enough to recognise a key, not enough to use it. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
}

/** "demain" / "le 1er novembre" / "le 1er janvier 2027": when a counter starts again from zero. */
export function formatResetDate(resetsAt: Date, now: Date): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (
    resetsAt.getFullYear() === tomorrow.getFullYear() &&
    resetsAt.getMonth() === tomorrow.getMonth() &&
    resetsAt.getDate() === tomorrow.getDate()
  ) {
    return 'demain';
  }
  const day = resetsAt.getDate();
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(resetsAt);
  const year = resetsAt.getFullYear() === now.getFullYear() ? '' : ` ${resetsAt.getFullYear()}`;
  return `le ${day === 1 ? '1er' : day} ${month}${year}`;
}

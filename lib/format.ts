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

/** "9 h" / "13 h 30": a local clock time, the French way. */
function formatClock(date: Date): string {
  const minutes = date.getMinutes();
  return minutes === 0
    ? `${date.getHours()} h`
    : `${date.getHours()} h ${String(minutes).padStart(2, '0')}`;
}

/** A day with a daylight saving change lasts 25 h. */
const WITHIN_A_DAY_MS = 25 * 60 * 60 * 1_000;

/**
 * When a counter starts again from zero, in the user's own time: "à 9 h" when that is within a
 * day, else "le 1er novembre à 9 h" ("le 1er janvier 2027 à 9 h" when it is next year).
 */
export function formatReset(resetsAt: Date, now: Date): string {
  const time = formatClock(resetsAt);
  if (resetsAt.getTime() - now.getTime() <= WITHIN_A_DAY_MS) return `à ${time}`;
  const day = resetsAt.getDate();
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(resetsAt);
  const year = resetsAt.getFullYear() === now.getFullYear() ? '' : ` ${resetsAt.getFullYear()}`;
  return `le ${day === 1 ? '1er' : day} ${month}${year} à ${time}`;
}

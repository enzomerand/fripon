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

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Calendar days from `from` to `to` on the user's clock (0 = same day, 1 = the next one...). */
function daysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  // Rounded: a day with a daylight saving change is not exactly 24 h long.
  return Math.round((end - start) / DAY_MS);
}

/**
 * When a counter starts again from zero, in the user's own time: "à 9 h" when that is today,
 * "demain à 9 h", else "le 1er novembre à 9 h" ("le 1er janvier 2027 à 9 h" when it is next year).
 */
export function formatReset(resetsAt: Date, now: Date): string {
  const time = formatClock(resetsAt);
  const days = daysBetween(now, resetsAt);
  if (days <= 0) return `à ${time}`;
  if (days === 1) return `demain à ${time}`;
  const day = resetsAt.getDate();
  const month = new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(resetsAt);
  const year = resetsAt.getFullYear() === now.getFullYear() ? '' : ` ${resetsAt.getFullYear()}`;
  return `le ${day === 1 ? '1er' : day} ${month}${year} à ${time}`;
}

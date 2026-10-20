import type { Money } from './model';

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30.4375;
const DAYS_PER_YEAR = 365;

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

/** Whole days elapsed since `createdAtIso`, or null when the date is missing or invalid. Never negative. */
export function accountAgeDays(createdAtIso: string | null, now: Date): number | null {
  if (!createdAtIso) return null;
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((now.getTime() - created) / MS_PER_DAY));
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Human age of an account: "aujourd'hui", "il y a 5 jours", "il y a 3 semaines",
 * "il y a 8 mois", "il y a 2 ans". Returns "" when the date is missing or invalid.
 */
export function formatAccountAge(createdAtIso: string | null, now: Date): string {
  const days = accountAgeDays(createdAtIso, now);
  if (days === null) return '';
  if (days < 1) return "aujourd'hui";
  if (days < DAYS_PER_WEEK) return `il y a ${plural(days, 'jour')}`;
  if (days < DAYS_PER_MONTH) return `il y a ${plural(Math.floor(days / DAYS_PER_WEEK), 'semaine')}`;
  if (days < DAYS_PER_YEAR) {
    const months = Math.max(1, Math.floor(days / DAYS_PER_MONTH));
    return `il y a ${months} mois`;
  }
  return `il y a ${plural(Math.max(1, Math.floor(days / DAYS_PER_YEAR)), 'an')}`;
}

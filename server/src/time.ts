/** Subscriber quotas count on the French calendar: a day and a month end at midnight in Paris. */
export const PARIS_TIME_ZONE = 'Europe/Paris';

/**
 * Google resets its quotas at midnight Pacific time (the extension's `lib/credits.ts` counts the
 * same way), so the global ceilings on the owner's Google spending count on that calendar.
 */
export const GOOGLE_TIME_ZONE = 'America/Los_Angeles';

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/**
 * The month (`YYYY-MM`) and the day (`YYYY-MM-DD`) an instant falls in, on the calendar of
 * `timeZone`: Paris by default (subscriber quotas), `GOOGLE_TIME_ZONE` for Google's own limits.
 */
export function periodIds(
  now: Date,
  timeZone: string = PARIS_TIME_ZONE,
): { month: string; day: string } {
  const parts: Record<string, string> = {};
  for (const part of formatFor(timeZone).formatToParts(now)) parts[part.type] = part.value;
  const month = `${parts.year}-${parts.month}`;
  return { month, day: `${month}-${parts.day}` };
}

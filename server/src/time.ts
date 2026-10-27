/** Quotas count on the French calendar: a day and a month end at midnight in Paris. */
const TIME_ZONE = 'Europe/Paris';

const parisFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The month (`YYYY-MM`) and the day (`YYYY-MM-DD`) an instant falls in, on the Paris calendar. */
export function periodIds(now: Date): { month: string; day: string } {
  const parts: Record<string, string> = {};
  for (const part of parisFormat.formatToParts(now)) parts[part.type] = part.value;
  const month = `${parts.year}-${parts.month}`;
  return { month, day: `${month}-${parts.day}` };
}

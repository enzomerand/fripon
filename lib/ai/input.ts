import { formatMoney } from '../format';
import { isRecord } from '../json';
import type { CheckId, CheckResult, Listing } from '../model';

/**
 * What the page sends the background to have a listing reviewed: the main photo (the background
 * downloads it) and the listing as text. No key is ever part of it.
 */
export interface AiReviewInput {
  photoUrl: string;
  title: string;
  description: string;
  /** The price as the buyer reads it, e.g. "12,00 €". */
  price: string;
  /** One plain French line per check Fripon ran. */
  signals: string[];
  /**
   * What the checks found, in short and stable words (see `reviewFingerprint`): the image
   * search's result first, then the status and tag of each row that ran. The cache key hashes
   * this, not the signal lines, whose counts ("12 avis", "30 articles") change from one visit to
   * the next without changing what there is to say.
   */
  fingerprint: string[];
}

/** The most the prompt (and so the cache key) ever sees of each part: a page cannot make it grow. */
export const REVIEW_LIMITS = {
  title: 200,
  description: 1_500,
  price: 40,
  signal: 400,
  signals: 12,
  fingerprint: 8,
  fingerprintLine: 200,
} as const;

/** Shape only: the sizes are bounded by `clampReviewInput`. */
export function isAiReviewInput(value: unknown): value is AiReviewInput {
  return (
    isRecord(value) &&
    typeof value.photoUrl === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.price === 'string' &&
    Array.isArray(value.signals) &&
    value.signals.every((line) => typeof line === 'string') &&
    Array.isArray(value.fingerprint) &&
    value.fingerprint.every((line) => typeof line === 'string')
  );
}

/** The first `max` UTF-16 units of `text`, without leaving the first half of an emoji at the end. */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(head) && text.length > max ? head.slice(0, -1) : head;
}

/** The same input with every part cut to `REVIEW_LIMITS`. */
export function clampReviewInput(input: AiReviewInput): AiReviewInput {
  return {
    photoUrl: input.photoUrl,
    title: cut(input.title, REVIEW_LIMITS.title),
    description: cut(input.description, REVIEW_LIMITS.description),
    price: cut(input.price, REVIEW_LIMITS.price),
    signals: input.signals
      .slice(0, REVIEW_LIMITS.signals)
      .map((line) => cut(line, REVIEW_LIMITS.signal)),
    fingerprint: input.fingerprint
      .slice(0, REVIEW_LIMITS.fingerprint)
      .map((line) => cut(line, REVIEW_LIMITS.fingerprintLine)),
  };
}

/** "Shein", "Shein et Temu", "Shein, Temu et AliExpress". */
function joinNames(names: string[]): string {
  return names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

/** What the image search found, in a sentence for the AI; "not done" whenever it did not run. */
function imageLine(image: CheckResult | undefined): string {
  if (!image || image.status === 'off') return "Recherche d'image : non faite.";
  const platforms = (exact: boolean) => [
    ...new Set((image.matches ?? []).filter((m) => m.exact === exact).map((m) => m.platform)),
  ];
  const copies = platforms(true);
  if (copies.length > 0) {
    return `Recherche d'image : la même photo est en vente sur ${joinNames(copies)}.`;
  }
  const lookalikes = platforms(false);
  if (lookalikes.length > 0) {
    return `Recherche d'image : une photo très proche existe sur ${joinNames(lookalikes)}.`;
  }
  return "Recherche d'image : aucune trace de la photo sur Shein, Temu, AliExpress…";
}

/** The rows that tell the AI something, with the name it reads them under. */
const ROW_NAMES: Array<[CheckId, string]> = [
  ['seller', 'Vendeur'],
  ['photos', 'Photos'],
  ['description', 'Description'],
];

/**
 * The signals Fripon computed, one plain French line each, for the AI to summarise. Built from the
 * rows as they were before any AI confirmation (`AnalysisResult.rawChecks`), so a review never
 * feeds on its own conclusion, and the same listing gives the same lines (they are part of the
 * cache key). A row that did not run says nothing: the AI must not guess at what was not read.
 */
export function signalLines(rawChecks: CheckResult[]): string[] {
  const lines = [imageLine(rawChecks.find((check) => check.id === 'image'))];
  for (const [id, name] of ROW_NAMES) {
    const row = rawChecks.find((check) => check.id === id);
    if (row && row.status !== 'off') lines.push(`${name} (${row.tag}) : ${row.detail}`);
  }
  return lines;
}

/**
 * What the image search found, as a review reads it. A review is based on it: when it changes (a
 * click ran the search, a retry succeeded), the review no longer says what the card shows and is
 * asked again.
 */
export function imageBasis(rawChecks: CheckResult[]): string {
  return imageLine(rawChecks.find((check) => check.id === 'image'));
}

/**
 * What the checks found, in short and stable words: the image line first (it names the platforms
 * and no number), then `id:status:tag` for each row that ran. It changes when a check changes its
 * mind, not when a count moves. The first element is also what the review is "based on" for the
 * page: when the image search's result changes, the review must be asked again.
 */
export function reviewFingerprint(rawChecks: CheckResult[]): string[] {
  const rows = ROW_NAMES.flatMap(([id]) => {
    const row = rawChecks.find((check) => check.id === id);
    return row && row.status !== 'off' ? [`${id}:${row.status}:${row.tag}`] : [];
  });
  return [imageBasis(rawChecks), ...rows];
}

/**
 * What the page sends to have a listing reviewed: its main photo, its text, the signals, and
 * their fingerprint.
 */
export function buildReviewInput(listing: Listing, rawChecks: CheckResult[]): AiReviewInput {
  return {
    photoUrl: listing.photoUrls[0] ?? '',
    title: listing.title,
    description: listing.description,
    price: formatMoney(listing.price),
    signals: signalLines(rawChecks),
    fingerprint: reviewFingerprint(rawChecks),
  };
}

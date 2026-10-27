import { isRecord } from '../json';

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
}

/** The most the prompt (and so the cache key) ever sees of each part: a page cannot make it grow. */
export const REVIEW_LIMITS = {
  title: 200,
  description: 1_500,
  price: 40,
  signal: 400,
  signals: 12,
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
    value.signals.every((line) => typeof line === 'string')
  );
}

/** The same input with every part cut to `REVIEW_LIMITS`. */
export function clampReviewInput(input: AiReviewInput): AiReviewInput {
  return {
    photoUrl: input.photoUrl,
    title: input.title.slice(0, REVIEW_LIMITS.title),
    description: input.description.slice(0, REVIEW_LIMITS.description),
    price: input.price.slice(0, REVIEW_LIMITS.price),
    signals: input.signals
      .slice(0, REVIEW_LIMITS.signals)
      .map((s) => s.slice(0, REVIEW_LIMITS.signal)),
  };
}

import { hammingDistance } from '../image/pixels';
import type { CheckResult, Signal } from '../model';

/** `catalogScore` at or above which the main photo counts as a studio / catalogue shot. */
export const CATALOG_THRESHOLD = 0.7;
/** Two photos whose hashes differ by at most this many bits are the same picture. */
export const REUSE_MAX_DISTANCE = 4;
/**
 * A hash with fewer than this many set bits (or more than `HASH_MAX_BITS`) comes from a nearly
 * flat picture (blank background, solid colour): every flat picture looks like every other one.
 */
export const HASH_MIN_BITS = 12;
export const HASH_MAX_BITS = 52;

/** The sentences of the row, kept apart so the AI confirmation can tell which ones still hold. */
const LOCAL_CATALOG_SENTENCE = 'Ressemble à une photo catalogue : fond uni et clair.';
const NOTHING_NOTABLE_SENTENCE = 'Pas de signe de photo catalogue ni de photo réutilisée.';
const NOT_ANALYSED_SENTENCE = "La photo n'a pas pu être analysée.";
/** What the row says when the AI confirms a catalogue shot that an exact image match backs. */
export const AI_CATALOG_TAG = 'Photo catalogue';
export const AI_CATALOG_SENTENCE = "L'IA confirme une photo de catalogue ou de studio.";
/** ... when it only sees one, with nothing else to back it: a weak hint, like the local one. */
export const AI_SEEN_TAG = 'Photo type catalogue';
export const AI_SEEN_SENTENCE = "L'IA voit une photo de catalogue ou de studio.";
/** ... when the local analysis could not read the photo at all. */
export const AI_SEEN_UNREAD_SENTENCE =
  "L'IA voit une photo de catalogue (analyse locale impossible).";

export interface PhotosInput {
  /** Hash and catalogue score of the listing's main photo, null when it could not be analysed. */
  main: { hash: bigint; catalogScore: number } | null;
  /** Hashes of the seller's other items' main photos (the listing itself excluded). */
  others: Array<{ itemId: string; hash: bigint }>;
}

/** false for the near-uniform hashes of flat pictures, which say nothing about identity. */
export function isInformativeHash(hash: bigint): boolean {
  const bits = hammingDistance(hash, 0n);
  return bits >= HASH_MIN_BITS && bits <= HASH_MAX_BITS;
}

/** Ids of the seller's other items whose photo is the same as `hash`. */
export function findReusedPhotos(hash: bigint, others: PhotosInput['others']): string[] {
  if (!isInformativeHash(hash)) return [];
  return others
    .filter(
      (other) =>
        isInformativeHash(other.hash) && hammingDistance(hash, other.hash) <= REUSE_MAX_DISTANCE,
    )
    .map((other) => other.itemId);
}

export function checkPhotos(input: PhotosInput): CheckResult {
  if (!input.main) {
    return {
      id: 'photos',
      status: 'off',
      tag: 'Non analysée',
      detail: NOT_ANALYSED_SENTENCE,
      signals: [],
    };
  }

  const catalog = input.main.catalogScore >= CATALOG_THRESHOLD;
  const reusedOn = findReusedPhotos(input.main.hash, input.others).length;

  const signals: Signal[] = [];
  // A studio-looking picture is only a local heuristic: it is a weak hint, never an accusation.
  if (catalog) signals.push({ id: 'catalog_photo', strength: 'weak' });
  if (reusedOn > 0) signals.push({ id: 'photo_reused', strength: 'weak' });

  const sentences: string[] = [];
  if (catalog) sentences.push(LOCAL_CATALOG_SENTENCE);
  if (reusedOn > 0) {
    sentences.push(
      `La même photo sert sur ${reusedOn} autre${reusedOn === 1 ? '' : 's'} annonce${reusedOn === 1 ? '' : 's'} du vendeur.`,
    );
  }
  if (sentences.length === 0) sentences.push(NOTHING_NOTABLE_SENTENCE);

  return {
    id: 'photos',
    status: catalog || reusedOn > 0 ? 'warn' : 'ok',
    tag: catalog ? 'Photo type catalogue' : reusedOn > 0 ? 'Photo réutilisée' : 'Rien de notable',
    detail: sentences.join(' '),
    signals,
  };
}

/**
 * The photos row once the AI says the photo is a catalogue or studio shot. The AI judged the
 * photo alone, whatever the local score said (a decorated background fools the local heuristic).
 *
 * How much that is worth depends on `backedByExactMatch`, whether the image search found this very
 * photo on a product page:
 * - with it, the `catalog_photo` signal is strong and the row red: "L'IA confirme…";
 * - without it, the signal stays weak and the row orange, like the local one: "L'IA voit…". A
 *   catalogue-looking photo alone proves nothing, so the AI by itself never moves a verdict
 *   through a strong signal.
 *
 * What the local row still says about reuse is kept; its own catalogue sentence, its "nothing
 * notable" and its "not analysed" give way to the AI's (which says so when the local analysis
 * could not read the photo). Only a "yes" goes through here: when the AI says the photo is not a
 * catalogue shot, the local row stays as it is.
 */
export function confirmCatalogPhoto(photos: CheckResult, backedByExactMatch: boolean): CheckResult {
  const kept = [LOCAL_CATALOG_SENTENCE, NOTHING_NOTABLE_SENTENCE, NOT_ANALYSED_SENTENCE]
    .reduce((detail, sentence) => detail.replace(sentence, ''), photos.detail)
    .trim();
  const sentence =
    photos.status === 'off'
      ? AI_SEEN_UNREAD_SENTENCE
      : backedByExactMatch
        ? AI_CATALOG_SENTENCE
        : AI_SEEN_SENTENCE;
  return {
    ...photos,
    status: backedByExactMatch ? 'bad' : 'warn',
    tag: backedByExactMatch ? AI_CATALOG_TAG : AI_SEEN_TAG,
    detail: kept === '' ? sentence : `${sentence} ${kept}`,
    signals: [
      { id: 'catalog_photo', strength: backedByExactMatch ? 'strong' : 'weak' },
      ...photos.signals.filter((signal) => signal.id !== 'catalog_photo'),
    ],
  };
}

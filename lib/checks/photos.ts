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
      detail: "La photo n'a pas pu être analysée.",
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
  if (catalog) sentences.push('Ressemble à une photo catalogue : fond uni et clair.');
  if (reusedOn > 0) {
    sentences.push(
      `La même photo sert sur ${reusedOn} autre${reusedOn === 1 ? '' : 's'} annonce${reusedOn === 1 ? '' : 's'} du vendeur.`,
    );
  }
  if (sentences.length === 0)
    sentences.push("Photo qui a l'air prise par le vendeur, pas de catalogue.");

  return {
    id: 'photos',
    status: catalog || reusedOn > 0 ? 'warn' : 'ok',
    tag: catalog ? 'Photo type catalogue' : reusedOn > 0 ? 'Photo réutilisée' : 'Photo réelle',
    detail: sentences.join(' '),
    signals,
  };
}

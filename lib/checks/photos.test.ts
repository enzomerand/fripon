import { describe, expect, it } from 'vitest';
import {
  CATALOG_THRESHOLD,
  checkPhotos,
  findReusedPhotos,
  isInformativeHash,
  REUSE_MAX_DISTANCE,
} from './photos';

const HASH = 0x0f0f_f0f0_1234_abcdn;

/** Flips the `count` lowest bits of a hash. */
const flip = (hash: bigint, count: number) => hash ^ ((1n << BigInt(count)) - 1n);

describe('checkPhotos', () => {
  it('is off when the main photo was not analysed', () => {
    expect(checkPhotos({ main: null, others: [] })).toEqual({
      id: 'photos',
      status: 'off',
      tag: 'Non analysée',
      detail: "La photo n'a pas pu être analysée.",
      signals: [],
    });
  });

  it('is ok for a real, unique photo', () => {
    const result = checkPhotos({
      main: { hash: HASH, catalogScore: 0.2 },
      others: [{ itemId: 'a', hash: ~HASH & ((1n << 64n) - 1n) }],
    });
    expect(result).toMatchObject({ status: 'ok', tag: 'Rien de notable', signals: [] });
  });

  it('is warn, never bad, for a catalogue-looking photo (weak)', () => {
    const result = checkPhotos({ main: { hash: HASH, catalogScore: 0.95 }, others: [] });
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('Photo type catalogue');
    expect(result.signals).toEqual([{ id: 'catalog_photo', strength: 'weak' }]);
    expect(result.detail.startsWith('Ressemble à une photo catalogue')).toBe(true);
  });

  it('flags the catalogue photo exactly at the threshold', () => {
    expect(
      checkPhotos({ main: { hash: HASH, catalogScore: CATALOG_THRESHOLD }, others: [] }).status,
    ).toBe('warn');
    expect(
      checkPhotos({ main: { hash: HASH, catalogScore: CATALOG_THRESHOLD - 0.01 }, others: [] })
        .status,
    ).toBe('ok');
  });

  it('is warn for a reused photo only (weak)', () => {
    const result = checkPhotos({
      main: { hash: HASH, catalogScore: 0.1 },
      others: [
        { itemId: 'a', hash: flip(HASH, 3) },
        { itemId: 'b', hash: flip(HASH, REUSE_MAX_DISTANCE) },
        { itemId: 'c', hash: flip(HASH, REUSE_MAX_DISTANCE + 1) },
      ],
    });
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('Photo réutilisée');
    expect(result.signals).toEqual([{ id: 'photo_reused', strength: 'weak' }]);
    expect(result.detail).toBe('La même photo sert sur 2 autres annonces du vendeur.');
  });

  it('uses the singular for one other listing', () => {
    const result = checkPhotos({
      main: { hash: HASH, catalogScore: 0.1 },
      others: [{ itemId: 'a', hash: HASH }],
    });
    expect(result.detail).toBe('La même photo sert sur 1 autre annonce du vendeur.');
  });

  it('keeps warn and lists both signals when the catalogue photo is also reused', () => {
    const result = checkPhotos({
      main: { hash: HASH, catalogScore: 0.9 },
      others: [
        { itemId: 'a', hash: HASH },
        { itemId: 'b', hash: HASH },
      ],
    });
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('Photo type catalogue');
    expect(result.signals.map((s) => s.id)).toEqual(['catalog_photo', 'photo_reused']);
    expect(result.detail).toBe(
      'Ressemble à une photo catalogue : fond uni et clair. La même photo sert sur 2 autres annonces du vendeur.',
    );
  });
});

describe('findReusedPhotos', () => {
  it('returns the ids of the near-identical photos', () => {
    expect(
      findReusedPhotos(HASH, [
        { itemId: 'a', hash: flip(HASH, 2) },
        { itemId: 'b', hash: flip(HASH, 20) },
      ]),
    ).toEqual(['a']);
  });
});

describe('flat pictures', () => {
  const FLAT = 0n;
  const FULL = (1n << 64n) - 1n;

  it('tells informative hashes from near-uniform ones', () => {
    expect(isInformativeHash(HASH)).toBe(true);
    expect(isInformativeHash(FLAT)).toBe(false);
    expect(isInformativeHash(FULL)).toBe(false);
    expect(isInformativeHash((1n << 11n) - 1n)).toBe(false); // 11 bits
    expect(isInformativeHash((1n << 12n) - 1n)).toBe(true); // 12 bits
    expect(isInformativeHash(FULL ^ ((1n << 11n) - 1n))).toBe(false); // 53 bits
    expect(isInformativeHash(FULL ^ ((1n << 12n) - 1n))).toBe(true); // 52 bits
  });

  it('never reports reuse between flat pictures', () => {
    expect(findReusedPhotos(FLAT, [{ itemId: 'a', hash: FLAT }])).toEqual([]);
    expect(findReusedPhotos(FULL, [{ itemId: 'a', hash: FULL }])).toEqual([]);
    const result = checkPhotos({
      main: { hash: FLAT, catalogScore: 0.1 },
      others: [{ itemId: 'a', hash: FLAT }],
    });
    expect(result).toMatchObject({ status: 'ok', signals: [] });
  });

  it('ignores a flat photo among the seller photos', () => {
    expect(findReusedPhotos(HASH, [{ itemId: 'a', hash: FLAT }])).toEqual([]);
  });

  it('reuse needs 4 differing bits at most', () => {
    expect(REUSE_MAX_DISTANCE).toBe(4);
  });
});

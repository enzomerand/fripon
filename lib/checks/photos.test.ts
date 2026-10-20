import { describe, expect, it } from 'vitest';
import { CATALOG_THRESHOLD, checkPhotos, findReusedPhotos, REUSE_MAX_DISTANCE } from './photos';

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
    expect(result).toMatchObject({ status: 'ok', tag: 'Photo réelle', signals: [] });
  });

  it('is bad for a catalogue photo (strong)', () => {
    const result = checkPhotos({ main: { hash: HASH, catalogScore: 0.95 }, others: [] });
    expect(result.status).toBe('bad');
    expect(result.tag).toBe('Photo catalogue');
    expect(result.signals).toEqual([{ id: 'catalog_photo', strength: 'strong' }]);
  });

  it('flags the catalogue photo exactly at the threshold', () => {
    expect(
      checkPhotos({ main: { hash: HASH, catalogScore: CATALOG_THRESHOLD }, others: [] }).status,
    ).toBe('bad');
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

  it('keeps bad and lists both signals when the catalogue photo is also reused', () => {
    const result = checkPhotos({
      main: { hash: HASH, catalogScore: 0.9 },
      others: [
        { itemId: 'a', hash: HASH },
        { itemId: 'b', hash: HASH },
      ],
    });
    expect(result.status).toBe('bad');
    expect(result.tag).toBe('Photo catalogue');
    expect(result.signals.map((s) => s.id)).toEqual(['catalog_photo', 'photo_reused']);
    expect(result.detail).toBe(
      'Fond uni et clair, comme sur une photo de catalogue. La même photo sert sur 2 autres annonces du vendeur.',
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

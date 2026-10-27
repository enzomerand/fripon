import { describe, expect, it } from 'vitest';
import {
  AI_CATALOG_SENTENCE,
  AI_CATALOG_TAG,
  AI_CATALOG_UNREAD_SENTENCE,
  AI_SEEN_SENTENCE,
  AI_SEEN_TAG,
  AI_SEEN_UNREAD_SENTENCE,
  CATALOG_THRESHOLD,
  checkPhotos,
  confirmCatalogPhoto,
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

describe('confirmCatalogPhoto', () => {
  const REUSED = [
    { itemId: 'a', hash: HASH },
    { itemId: 'b', hash: HASH },
  ];
  const local = (catalogScore: number, others: typeof REUSED = []) =>
    checkPhotos({ main: { hash: HASH, catalogScore }, others });

  describe('backed by an exact image match', () => {
    const confirmed = (catalogScore: number, others: typeof REUSED = []) =>
      confirmCatalogPhoto(local(catalogScore, others), true);

    it('makes the row a strong catalogue hint, whatever the local score said', () => {
      for (const score of [0.0, 0.2, CATALOG_THRESHOLD, 0.95]) {
        expect(confirmed(score)).toEqual({
          id: 'photos',
          status: 'bad',
          tag: 'Photo catalogue',
          detail: "L'IA confirme une photo de catalogue ou de studio.",
          signals: [{ id: 'catalog_photo', strength: 'strong' }],
        });
      }
      expect(AI_CATALOG_TAG).toBe('Photo catalogue');
      expect(AI_CATALOG_SENTENCE).toBe("L'IA confirme une photo de catalogue ou de studio.");
    });

    it('replaces the weak local catalogue hint instead of listing the signal twice', () => {
      const row = confirmed(0.95);
      expect(row.signals).toEqual([{ id: 'catalog_photo', strength: 'strong' }]);
      expect(row.detail).not.toContain('Ressemble à');
    });

    it('keeps what the row says about a photo reused on other listings', () => {
      const row = confirmed(0.1, REUSED);
      expect(row.signals).toEqual([
        { id: 'catalog_photo', strength: 'strong' },
        { id: 'photo_reused', strength: 'weak' },
      ]);
      expect(row.detail).toBe(
        "L'IA confirme une photo de catalogue ou de studio. La même photo sert sur 2 autres annonces du vendeur.",
      );
      expect(confirmed(0.95, REUSED).detail).toBe(row.detail);
    });
  });

  describe('with nothing else to back it', () => {
    const seen = (catalogScore: number, others: typeof REUSED = []) =>
      confirmCatalogPhoto(local(catalogScore, others), false);

    it('is only a weak hint on an orange row, whatever the local score said', () => {
      for (const score of [0.0, 0.2, CATALOG_THRESHOLD, 0.95]) {
        expect(seen(score)).toEqual({
          id: 'photos',
          status: 'warn',
          tag: 'Photo type catalogue',
          detail: "L'IA voit une photo de catalogue ou de studio.",
          signals: [{ id: 'catalog_photo', strength: 'weak' }],
        });
      }
      expect(AI_SEEN_TAG).toBe('Photo type catalogue');
      expect(AI_SEEN_SENTENCE).toBe("L'IA voit une photo de catalogue ou de studio.");
    });

    it('never gives a strong signal, reuse or not', () => {
      for (const row of [seen(0.1), seen(0.95), seen(0.1, REUSED)]) {
        expect(row.signals.every((signal) => signal.strength === 'weak')).toBe(true);
        expect(row.status).toBe('warn');
      }
    });

    it('keeps what the row says about a photo reused on other listings', () => {
      const row = seen(0.1, REUSED);
      expect(row.signals.map((signal) => signal.id)).toEqual(['catalog_photo', 'photo_reused']);
      expect(row.detail).toBe(
        "L'IA voit une photo de catalogue ou de studio. La même photo sert sur 2 autres annonces du vendeur.",
      );
    });
  });

  describe('when the local analysis could not read the photo', () => {
    const unread = checkPhotos({ main: null, others: [] });

    it('confirms it, with a strong signal, when an exact match backs it', () => {
      expect(confirmCatalogPhoto(unread, true)).toEqual({
        id: 'photos',
        status: 'bad',
        tag: 'Photo catalogue',
        detail: "L'IA confirme une photo de catalogue ou de studio (analyse locale impossible).",
        signals: [{ id: 'catalog_photo', strength: 'strong' }],
      });
      expect(AI_CATALOG_UNREAD_SENTENCE).toBe(
        "L'IA confirme une photo de catalogue ou de studio (analyse locale impossible).",
      );
    });

    it('only sees it, with a weak signal, otherwise', () => {
      expect(confirmCatalogPhoto(unread, false)).toEqual({
        id: 'photos',
        status: 'warn',
        tag: 'Photo type catalogue',
        detail: "L'IA voit une photo de catalogue (analyse locale impossible).",
        signals: [{ id: 'catalog_photo', strength: 'weak' }],
      });
      expect(AI_SEEN_UNREAD_SENTENCE).toBe(
        "L'IA voit une photo de catalogue (analyse locale impossible).",
      );
    });
  });

  it('does not change the row it is given', () => {
    const row = local(0.95);
    const snapshot = structuredClone(row);
    confirmCatalogPhoto(row, true);
    confirmCatalogPhoto(row, false);
    expect(row).toEqual(snapshot);
  });
});

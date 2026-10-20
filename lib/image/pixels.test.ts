import { describe, expect, it } from 'vitest';
import { catalogScore, dHash, hammingDistance, hashToHex, hexToHash } from './pixels';

/** Deterministic PRNG so the noisy fixtures never flake. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Painter = (x: number, y: number) => [number, number, number];

function image(w: number, h: number, paint: Painter): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const W = 128;
const H = 160;

/** Soft diagonal gradient with a dark blob: a stand-in for a real photo. */
const scene: Painter = (x, y) => {
  const base = 60 + (x / W) * 120 + (y / H) * 40;
  const blob = Math.hypot(x - 40, y - 100) < 30 ? -50 : 0;
  const v = Math.min(255, Math.max(0, base + blob));
  return [v, v * 0.9, v * 0.8];
};

/** A different composition: bright blob top-right on a dark vertical ramp. */
const otherScene: Painter = (x, y) => {
  const base = 200 - (y / H) * 150;
  const blob = Math.hypot(x - 100, y - 30) < 35 ? 60 : 0;
  const v = Math.min(255, Math.max(0, base + blob - (x / W) * 40));
  return [v * 0.7, v, v * 0.9];
};

describe('dHash', () => {
  it('is deterministic and fits 64 bits', () => {
    const px = image(W, H, scene);
    const hash = dHash(px, W, H);
    expect(dHash(px, W, H)).toBe(hash);
    expect(hash).toBeGreaterThanOrEqual(0n);
    expect(hash).toBeLessThan(1n << 64n);
  });

  it('gives distance 0 for identical images', () => {
    expect(hammingDistance(dHash(image(W, H, scene), W, H), dHash(image(W, H, scene), W, H))).toBe(
      0,
    );
  });

  it('survives a brightness change', () => {
    const brighter: Painter = (x, y) =>
      scene(x, y).map((v) => Math.min(255, v + 25)) as [number, number, number];
    const d = hammingDistance(dHash(image(W, H, scene), W, H), dHash(image(W, H, brighter), W, H));
    expect(d).toBeLessThanOrEqual(4);
  });

  it('survives a rescale and mild noise', () => {
    const rng = mulberry32(7);
    const noisy: Painter = (x, y) =>
      scene(x, y).map((v) => v + (rng() - 0.5) * 8) as [number, number, number];
    const small = image(64, 80, (x, y) => scene(x * 2, y * 2));
    const base = dHash(image(W, H, scene), W, H);
    expect(hammingDistance(base, dHash(image(W, H, noisy), W, H))).toBeLessThanOrEqual(6);
    expect(hammingDistance(base, dHash(small, 64, 80))).toBeLessThanOrEqual(6);
  });

  it('is far for a different image', () => {
    const d = hammingDistance(
      dHash(image(W, H, scene), W, H),
      dHash(image(W, H, otherScene), W, H),
    );
    expect(d).toBeGreaterThanOrEqual(20);
  });

  it('handles images smaller than the hash grid', () => {
    const px = image(3, 2, (x, y) => [x * 80, y * 80, 0]);
    expect(() => dHash(px, 3, 2)).not.toThrow();
  });
});

describe('hammingDistance', () => {
  it('counts differing bits', () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0b1011n, 0b0010n)).toBe(2);
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
  });
});

describe('hash hex round trip', () => {
  it('pads to 16 digits and parses back', () => {
    expect(hashToHex(255n)).toBe('00000000000000ff');
    expect(hexToHash(hashToHex(0xdeadbeefcafen))).toBe(0xdeadbeefcafen);
  });
});

describe('catalogScore', () => {
  it('scores a white backdrop with a centred subject high', () => {
    const rng = mulberry32(3);
    const studio = image(W, H, (x, y) => {
      const inSubject = Math.abs(x - W / 2) < 30 && y > 20 && y < H - 20;
      if (inSubject) return [140, 90, 110];
      const n = (rng() - 0.5) * 6;
      return [246 + n, 246 + n, 246 + n];
    });
    expect(catalogScore(studio, W, H)).toBeGreaterThan(0.9);
  });

  it('scores a noisy cluttered photo low', () => {
    const rng = mulberry32(11);
    const cluttered = image(W, H, () => [rng() * 255, rng() * 255, rng() * 255]);
    expect(catalogScore(cluttered, W, H)).toBeLessThan(0.2);
  });

  it('scores a room-like gradient low', () => {
    expect(catalogScore(image(W, H, scene), W, H)).toBeLessThan(0.5);
  });

  it('does not count a dark uniform border as a light studio backdrop', () => {
    const dark = image(W, H, () => [20, 20, 20]);
    expect(catalogScore(dark, W, H)).toBe(0);
  });

  it('stays within 0..1 and tolerates tiny images', () => {
    const white = image(4, 4, () => [255, 255, 255]);
    const score = catalogScore(white, 4, 4);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
    expect(catalogScore(new Uint8ClampedArray(0), 0, 0)).toBe(0);
  });
});

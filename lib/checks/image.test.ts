import { describe, expect, it } from 'vitest';
import { googleLensUrl, imageCheckOff } from './image';

describe('googleLensUrl', () => {
  it('encodes the photo URL in the Lens upload-by-url link', () => {
    const photo = 'https://images1.vinted.net/t/01_abc/f800/123.jpeg?s=a&b=c d';
    const url = googleLensUrl(photo);
    expect(url).toBe(`https://lens.google.com/uploadbyurl?url=${encodeURIComponent(photo)}`);
    expect(new URL(url).searchParams.get('url')).toBe(photo);
  });
});

describe('imageCheckOff', () => {
  it.each(['no_key', 'quota', 'manual'] as const)('is an off image row for %s', (reason) => {
    const result = imageCheckOff(reason);
    expect(result).toMatchObject({ id: 'image', status: 'off', tag: 'Désactivée', signals: [] });
    expect(result.detail.length).toBeGreaterThan(10);
  });

  it('tells the user to add a key when there is none', () => {
    expect(imageCheckOff('no_key').detail).toBe(
      'Ajoute une clé Google pour retrouver la photo sur Shein, Temu…',
    );
  });

  it('gives a different explanation per reason', () => {
    const details = new Set(
      (['no_key', 'quota', 'manual'] as const).map((r) => imageCheckOff(r).detail),
    );
    expect(details.size).toBe(3);
  });
});

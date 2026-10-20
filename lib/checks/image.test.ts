import { describe, expect, it } from 'vitest';
import { googleLensUrl, imageCheckForGate, imageCheckOff, imageCheckReady } from './image';

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
    expect(result).toMatchObject({ id: 'image', status: 'off', signals: [] });
    expect(result.tag.length).toBeGreaterThan(3);
    expect(result.detail.length).toBeGreaterThan(10);
  });

  it('says the search is disabled without a key or in manual mode, and the cap reached on quota', () => {
    expect(imageCheckOff('no_key').tag).toBe('Désactivée');
    expect(imageCheckOff('manual').tag).toBe('Désactivée');
    expect(imageCheckOff('quota').tag).toBe('Plafond atteint');
  });

  it('offers the guide without a key and the settings on quota, nothing yet in manual mode', () => {
    expect(imageCheckOff('no_key').action).toBe('open_guide');
    expect(imageCheckOff('quota').action).toBe('open_settings');
    expect(imageCheckOff('manual')).not.toHaveProperty('action');
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

describe('imageCheckReady', () => {
  it('tells the key is saved and the search is coming', () => {
    expect(imageCheckReady()).toEqual({
      id: 'image',
      status: 'off',
      tag: 'Clé prête',
      detail:
        "Ta clé est enregistrée : la recherche d'image arrive avec la prochaine version de Fripon.",
      signals: [],
    });
  });
});

describe('imageCheckForGate', () => {
  it('maps each gate to its row', () => {
    expect(imageCheckForGate('ready')).toEqual(imageCheckReady());
    for (const gate of ['no_key', 'quota', 'manual'] as const) {
      expect(imageCheckForGate(gate)).toEqual(imageCheckOff(gate));
    }
  });
});

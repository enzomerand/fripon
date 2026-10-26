import { describe, expect, it } from 'vitest';
import type { ImageMatch } from '../model';
import {
  googleLensUrl,
  imageCheckFailed,
  imageCheckForMatches,
  imageCheckForSearch,
  imageCheckOff,
  imageCheckSearching,
} from './image';

const exactShein: ImageMatch = {
  platform: 'Shein',
  url: 'https://fr.shein.com/Robe-p-1.html',
  exact: true,
  price: null,
};
const similarTemu: ImageMatch = {
  platform: 'Temu',
  url: 'https://www.temu.com/robe-g-2.html',
  exact: false,
  price: null,
};

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

  it('says the search is disabled without a key, the cap reached on quota, "au clic" in manual mode', () => {
    expect(imageCheckOff('no_key').tag).toBe('Désactivée');
    expect(imageCheckOff('quota').tag).toBe('Plafond atteint');
    expect(imageCheckOff('manual').tag).toBe('Au clic');
  });

  it('offers the guide without a key, the settings on quota, and the search button in manual mode', () => {
    expect(imageCheckOff('no_key').action).toBe('open_guide');
    expect(imageCheckOff('quota').action).toBe('open_settings');
    expect(imageCheckOff('manual').action).toBe('run_image_search');
  });

  it('tells the user to add a key when there is none', () => {
    expect(imageCheckOff('no_key').detail).toBe(
      'Ajoute une clé Google pour retrouver la photo sur Shein, Temu…',
    );
  });

  it('invites the user to run the search in manual mode, without promising a later version', () => {
    expect(imageCheckOff('manual').detail).toBe(
      "Tu as choisi l'analyse au clic : lance la recherche d'image quand tu veux.",
    );
  });

  it('gives a different explanation per reason', () => {
    const details = new Set(
      (['no_key', 'quota', 'manual'] as const).map((r) => imageCheckOff(r).detail),
    );
    expect(details.size).toBe(3);
  });
});

describe('imageCheckSearching', () => {
  it('is an off row that says the search is running, with no button', () => {
    expect(imageCheckSearching()).toEqual({
      id: 'image',
      status: 'off',
      tag: 'En cours',
      detail: 'Recherche en cours…',
      signals: [],
    });
  });
});

describe('imageCheckForMatches', () => {
  it('is red and names the platform for an exact match', () => {
    const row = imageCheckForMatches([exactShein, similarTemu]);
    expect(row).toMatchObject({
      id: 'image',
      status: 'bad',
      tag: 'Trouvée sur Shein',
      detail: 'La même photo est en vente sur Shein.',
      signals: [],
    });
    expect(row.matches).toEqual([exactShein, similarTemu]);
    expect(row).not.toHaveProperty('action');
  });

  it('reads the exact match wherever it is in the list', () => {
    const row = imageCheckForMatches([similarTemu, exactShein]);
    expect(row).toMatchObject({
      status: 'bad',
      tag: 'Trouvée sur Shein',
      detail: 'La même photo est en vente sur Shein.',
    });
    expect(row.matches).toEqual([similarTemu, exactShein]);
  });

  it('names the platform of the first exact match when several are exact', () => {
    const exactTemu: ImageMatch = { ...similarTemu, exact: true };
    expect(imageCheckForMatches([similarTemu, exactTemu, exactShein]).tag).toBe('Trouvée sur Temu');
  });

  it('is orange for pages that only look like the photo', () => {
    const row = imageCheckForMatches([similarTemu]);
    expect(row).toMatchObject({
      status: 'warn',
      tag: 'Photo proche',
      detail: 'Une photo très proche existe sur Temu.',
    });
    expect(row.matches).toEqual([similarTemu]);
  });

  it('is green when nothing was found', () => {
    expect(imageCheckForMatches([])).toEqual({
      id: 'image',
      status: 'ok',
      tag: 'Introuvable',
      detail: 'Aucune trace de cette photo sur Shein, Temu, AliExpress…',
      signals: [],
    });
  });
});

describe('imageCheckFailed', () => {
  const keyRefused = 'Google refuse ta clé Vision : vérifie-la dans les réglages.';

  it.each(['invalid', 'restricted', 'disabled', 'billing'] as const)(
    'sends the user to the keys section when the problem is the key (%s)',
    (reason) => {
      expect(imageCheckFailed(reason)).toEqual({
        id: 'image',
        status: 'off',
        tag: 'Recherche impossible',
        detail: keyRefused,
        signals: [],
        action: 'open_keys',
      });
    },
  );

  it('says Google does not answer on a network failure', () => {
    expect(imageCheckFailed('network')).toMatchObject({
      status: 'off',
      tag: 'Recherche impossible',
      detail: 'Google ne répond pas, réessaie plus tard.',
    });
  });

  it('explains a quota used up at Google and a photo that could not be analysed', () => {
    expect(imageCheckFailed('quota').detail).toBe(
      'Google a atteint le quota de ta clé Vision, réessaie plus tard.',
    );
    expect(imageCheckFailed('photo').detail).toBe(
      "La photo de l'annonce n'a pas pu être analysée.",
    );
  });

  it.each(['network', 'quota'] as const)(
    'offers to search again when the failure may pass (%s)',
    (reason) => {
      expect(imageCheckFailed(reason)).toMatchObject({
        action: 'run_image_search',
        actionLabel: 'Réessayer la recherche',
      });
    },
  );

  it('offers nothing for a photo that failed: it would fail again, at a credit a click', () => {
    const row = imageCheckFailed('photo');
    expect(row).not.toHaveProperty('action');
    expect(row).not.toHaveProperty('actionLabel');
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing'] as const)(
    'does not offer to search again when the key is the problem (%s)',
    (reason) => {
      expect(imageCheckFailed(reason)).not.toHaveProperty('actionLabel');
      expect(imageCheckFailed(reason).action).toBe('open_keys');
    },
  );
});

describe('imageCheckForSearch', () => {
  it('maps each answer of the background to its row', () => {
    expect(imageCheckForSearch({ status: 'ok', matches: [exactShein] })).toEqual(
      imageCheckForMatches([exactShein]),
    );
    expect(imageCheckForSearch({ status: 'no_key' })).toEqual(imageCheckOff('no_key'));
    expect(imageCheckForSearch({ status: 'quota' })).toEqual(imageCheckOff('quota'));
    // Asked for the cache alone and not there: back to the row that waits for a click.
    expect(imageCheckForSearch({ status: 'not_cached' })).toEqual(imageCheckOff('manual'));
    expect(imageCheckForSearch({ status: 'error', reason: 'billing' })).toEqual(
      imageCheckFailed('billing'),
    );
  });
});

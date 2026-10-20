import { describe, expect, it } from 'vitest';
import type { Listing } from '../model';
import {
  checkDescription,
  isNoBrand,
  looksFrenchOrEnglish,
  MARKETPLACE_SCORE_THRESHOLD,
  scoreMarketplaceStyle,
} from './description';

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: '1',
    url: 'https://www.vinted.fr/items/1',
    title: 'Robe',
    description: '',
    price: { amount: 20, currency: 'EUR' },
    brand: 'Zara',
    size: 'M',
    condition: 'good',
    photoUrls: [],
    sellerId: 's1',
    ...overrides,
  };
}

const GENUINE_FR = listing({
  title: 'Robe Zara fleurie taille M',
  description:
    "Je vends ma robe Zara que j'ai portée deux fois cet été, elle est en très bon état.\n" +
    "Matière : coton. Elle taille un peu grand, c'est pour ça que je la vends.\n" +
    'Envoi soigné sous 48h, je peux faire un lot si tu en prends plusieurs !',
});

const GENUINE_EN = listing({
  title: 'Floral summer dress Mango',
  description:
    'Bought this dress last summer and wore it twice. It is in great condition, just a bit too ' +
    'small for me now. Happy to answer any questions and to send more photos if you want.',
  brand: 'Mango',
});

const SHEIN_FR = listing({
  title: '2024 Nouveau Femmes Robe Décontractée Élégante Été Fleurie',
  description:
    'Style : Décontracté\n' +
    'Matière : Polyester\n' +
    'Saison : Été\n' +
    'Occasion : Quotidien\n' +
    'Le colis comprend : 1 x Robe\n' +
    'Veuillez permettre une erreur de 1 à 3 cm due à la mesure manuelle.',
  brand: null,
});

const SHEIN_EN = listing({
  title: "Women's Summer Casual Floral Print V Neck Short Sleeve Mini Dress",
  description:
    'Material: 95% Polyester, 5% Spandex\n' +
    'Style: Casual\n' +
    'Season: Summer\n' +
    'Size chart:\n' +
    'S: Bust 88cm, Length 90cm\n' +
    'M: Bust 92cm, Length 91cm\n' +
    'L: Bust 96cm, Length 92cm\n' +
    'Please allow 1-3cm error due to manual measurement.',
  brand: 'Sans marque',
});

describe('checkDescription', () => {
  it('finds a genuine French description normal', () => {
    const result = checkDescription(GENUINE_FR);
    expect(result).toMatchObject({ id: 'description', status: 'ok', tag: 'Normale', signals: [] });
    expect(result.detail).toBe("Le texte a l'air d'une vraie annonce de particulier.");
  });

  it('finds a genuine English description normal', () => {
    const result = checkDescription(GENUINE_EN);
    expect(result.status).toBe('ok');
    expect(result.signals).toEqual([]);
  });

  it('warns on a Shein-like French copy', () => {
    const result = checkDescription(SHEIN_FR);
    expect(result.status).toBe('warn');
    expect(result.tag).toBe('Style boutique');
    expect(result.signals).toEqual([
      { id: 'marketplace_style_text', strength: 'weak' },
      { id: 'no_brand', strength: 'weak' },
    ]);
    expect(result.detail).toContain('fiche produit de boutique en ligne');
    expect(result.detail).toContain('fiche technique');
    expect(result.detail).toContain('Aucune marque indiquée.');
  });

  it('warns on a Shein-like English copy', () => {
    const result = checkDescription(SHEIN_EN);
    expect(result.status).toBe('warn');
    expect(result.signals.map((s) => s.id)).toEqual(['marketplace_style_text', 'no_brand']);
  });

  it('keeps ok with a mention when only the brand is missing', () => {
    const result = checkDescription({ ...GENUINE_FR, brand: null });
    expect(result.status).toBe('ok');
    expect(result.tag).toBe('Normale');
    expect(result.signals).toEqual([{ id: 'no_brand', strength: 'weak' }]);
    expect(result.detail).toBe(
      "Le texte a l'air d'une vraie annonce de particulier. Aucune marque indiquée.",
    );
  });

  it('is off for languages it does not handle', () => {
    const german = listing({
      title: 'Kleid Zara Größe M',
      description:
        'Ich verkaufe dieses Kleid, es ist sehr schön und ich habe es nur einmal getragen. ' +
        'Die Größe ist M und der Zustand ist sehr gut.',
    });
    expect(checkDescription(german)).toEqual({
      id: 'description',
      status: 'off',
      tag: 'Non disponible',
      detail: 'Vérification non disponible dans cette langue.',
      signals: [],
    });
    const spanish = listing({
      title: 'Vestido Zara talla M',
      description:
        'Vendo este vestido que me queda muy grande, está como nuevo y solo lo he usado una vez. ' +
        'La talla es la M y el envío es con correos.',
    });
    expect(checkDescription(spanish).status).toBe('off');
  });
});

describe('checkDescription without text', () => {
  it.each(['', '   \n '])('is off and unreadable for %j', (description) => {
    expect(checkDescription({ ...GENUINE_FR, description })).toEqual({
      id: 'description',
      status: 'off',
      tag: 'Illisible',
      detail: 'Description illisible.',
      signals: [],
    });
  });
});

describe('looksFrenchOrEnglish', () => {
  it('recognises French and English', () => {
    expect(looksFrenchOrEnglish('Je vends cette robe, elle est très jolie et en bon état.')).toBe(
      true,
    );
    expect(looksFrenchOrEnglish('This is a very nice dress and it is in good condition.')).toBe(
      true,
    );
  });

  it('does not rule out a short title it cannot place', () => {
    expect(looksFrenchOrEnglish('Robe fleurie')).toBe(true);
  });

  it('rejects Italian', () => {
    expect(
      looksFrenchOrEnglish(
        'Vendo questo vestito che non uso più, è molto bello e come nuovo, taglia M.',
      ),
    ).toBe(false);
  });
});

describe('scoreMarketplaceStyle', () => {
  it('stays under the threshold for each lone weak habit', () => {
    const lone = [
      scoreMarketplaceStyle('Robe', 'Matière : coton'),
      scoreMarketplaceStyle('Nike Air Max 90 Triple White Edition', ''),
      scoreMarketplaceStyle("Women's summer dress", ''),
      scoreMarketplaceStyle('Robe', 'Composition : 100% polyester\nTaille : M'),
      scoreMarketplaceStyle('Robe', 'Collection 2024, neuve avec étiquette'),
    ];
    for (const result of lone) expect(result.score).toBeLessThan(MARKETPLACE_SCORE_THRESHOLD);
  });

  it('detects an English apparel title', () => {
    expect(scoreMarketplaceStyle("Women's Casual Loose Dress", '').reasons).toContain(
      'english_title',
    );
  });

  it('detects keyword stacking by capitals and by separators', () => {
    expect(
      scoreMarketplaceStyle('Robe Longue Fleurie Manches Courtes Col Rond Été', '').reasons,
    ).toContain('keyword_stacking');
    expect(
      scoreMarketplaceStyle('robe, femme, été, fleurie, casual, élégante', '').reasons,
    ).toContain('keyword_stacking');
    expect(scoreMarketplaceStyle('Robe Zara fleurie', '').reasons).not.toContain(
      'keyword_stacking',
    );
  });

  it('detects a spec sheet, counting distinct keys', () => {
    const one = scoreMarketplaceStyle('Robe', 'Matière : Polyester');
    const three = scoreMarketplaceStyle(
      'Robe',
      '- Style: Casual\n- Material: Polyester\n- Season: Summer',
    );
    expect(one.score).toBe(1);
    // Capped at 2: a label copied line by line is not enough on its own.
    expect(three.score).toBe(2);
    expect(three.reasons).toEqual(['spec_sheet']);
  });

  it('reads inline spec fields separated by pipes', () => {
    const result = scoreMarketplaceStyle(
      'Robe',
      'Style : Casual | Saison : Été | Matière : Polyester',
    );
    expect(result.reasons).toEqual(['spec_sheet']);
    expect(result.score).toBeLessThan(MARKETPLACE_SCORE_THRESHOLD);
  });

  it('caps the spec sheet, fibre blend included', () => {
    const sheet = scoreMarketplaceStyle(
      'Robe',
      'Matière : 95% polyester, 5% spandex\nStyle : casual\nSaison : été\nOccasion : fête',
    );
    expect(sheet.score).toBe(2);
    // ...but it adds up with another rule.
    const withYear = scoreMarketplaceStyle(
      'Nouveau 2025 robe',
      'Style : casual\nSaison : été\nOccasion : fête',
    );
    expect(withYear.score).toBeGreaterThanOrEqual(MARKETPLACE_SCORE_THRESHOLD);
  });

  it('does not read an ordinary sentence with commas as keyword stacking', () => {
    const sentence = 'Robe portée deux fois, lavée, repassée, en très bon état, taille M';
    expect(scoreMarketplaceStyle(sentence, '').reasons).not.toContain('keyword_stacking');
    const lines = scoreMarketplaceStyle(
      'Robe',
      'Je la vends parce que, franchement, elle est trop grande, et puis, bon, voilà',
    );
    expect(lines.reasons).not.toContain('keyword_stacking');
  });

  it('detects a year with "new" in either order', () => {
    expect(scoreMarketplaceStyle('Nouveau 2025 robe', '').reasons).toContain('year_new_arrival');
    expect(scoreMarketplaceStyle('Robe', 'New Arrival 2024').reasons).toContain('year_new_arrival');
  });

  it('detects a size chart by phrase and by lines', () => {
    expect(
      scoreMarketplaceStyle('Robe', 'Veuillez consulter le guide des tailles').reasons,
    ).toContain('size_chart');
    const table = 'S: 88cm\nM: 92cm\nL: 96cm';
    expect(scoreMarketplaceStyle('Robe', table).reasons).toContain('size_chart');
    expect(scoreMarketplaceStyle('Robe', 'S: 88cm\nM: 92cm').reasons).not.toContain('size_chart');
  });
});

describe('isNoBrand', () => {
  it.each([
    [undefined, false],
    [null, true],
    ['', true],
    ['Sans marque', true],
    ['sans-marque', true],
    ['No brand', true],
    ['Unbranded', true],
    ['Ohne Marke', true],
    ['Sin marca', true],
    ['Senza marca', true],
    ['Zara', false],
    ['Marque Verte', false],
  ])('%s -> %s', (brand, expected) => {
    expect(isNoBrand(brand)).toBe(expected);
  });
});

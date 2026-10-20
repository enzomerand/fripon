import { describe, expect, it } from 'vitest';
import type { Condition } from '../model';
import { conditionFromLabel } from './condition';

describe('conditionFromLabel', () => {
  const labels: Record<string, Array<[string, Condition]>> = {
    fr: [
      ['Neuf avec étiquette', 'new_with_tags'],
      ['Neuf sans étiquette', 'new_without_tags'],
      ['Très bon état', 'very_good'],
      ['Bon état', 'good'],
      ['Satisfaisant', 'satisfactory'],
    ],
    en: [
      ['New with tags', 'new_with_tags'],
      ['New without tags', 'new_without_tags'],
      ['Very good', 'very_good'],
      ['Good', 'good'],
      ['Satisfactory', 'satisfactory'],
    ],
    de: [
      ['Neu mit Etikett', 'new_with_tags'],
      ['Neu ohne Etikett', 'new_without_tags'],
      ['Sehr gut', 'very_good'],
      ['Gut', 'good'],
      ['Zufriedenstellend', 'satisfactory'],
    ],
    es: [
      ['Nuevo con etiquetas', 'new_with_tags'],
      ['Nuevo sin etiquetas', 'new_without_tags'],
      ['Muy bueno', 'very_good'],
      ['Bueno', 'good'],
      ['Satisfactorio', 'satisfactory'],
    ],
    it: [
      ['Nuovo con cartellino', 'new_with_tags'],
      ['Nuovo senza cartellino', 'new_without_tags'],
      ['Ottime condizioni', 'very_good'],
      ['Buone condizioni', 'good'],
      ['Condizioni soddisfacenti', 'satisfactory'],
    ],
    nl: [
      ['Nieuw met kaartje', 'new_with_tags'],
      ['Nieuw zonder kaartje', 'new_without_tags'],
      ['Heel goed', 'very_good'],
      ['Goed', 'good'],
      ['Redelijk', 'satisfactory'],
    ],
    pl: [
      ['Nowe z metką', 'new_with_tags'],
      ['Nowe bez metki', 'new_without_tags'],
      ['Bardzo dobry', 'very_good'],
      ['Dobry', 'good'],
      ['Zadowalający', 'satisfactory'],
    ],
  };

  for (const [language, cases] of Object.entries(labels)) {
    it(`understands the ${language} labels`, () => {
      for (const [label, expected] of cases) {
        expect(conditionFromLabel(label), label).toBe(expected);
      }
    });
  }

  it('copes with the row title glued to the value', () => {
    expect(conditionFromLabel('ÉtatNeuf avec étiquette')).toBe('new_with_tags');
    expect(conditionFromLabel('ÉtatTrès bon état')).toBe('very_good');
    expect(conditionFromLabel('ZustandGut')).toBe('good');
  });

  it('is unknown for empty or unrecognised text', () => {
    expect(conditionFromLabel('')).toBe('unknown');
    expect(conditionFromLabel(null)).toBe('unknown');
    expect(conditionFromLabel('Pristine')).toBe('unknown');
  });
});

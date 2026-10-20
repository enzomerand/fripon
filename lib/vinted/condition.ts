import type { Condition } from '../model';
import { stripAccents } from '../text';

/**
 * Localized labels (fr, en, de, es, it, nl, pl), matched on their normalized form (lowercase, no
 * accents). Order matters: "sans/without" before "avec/with" and "très bon" before "bon", because
 * the shorter labels are substrings of the longer ones. The status row text glues the row title to
 * the value ("ÉtatNeuf avec étiquette"), so matching is by substring, not by equality.
 */
const LABEL_PATTERNS: ReadonlyArray<readonly [Condition, readonly string[]]> = [
  [
    'new_without_tags',
    [
      'sans etiquette', // fr
      'without tags', // en
      'ohne etikett', // de
      'sin etiqueta', // es
      'senza cartellino', // it
      'zonder', // nl: "Nieuw zonder kaartje"
      'bez metki', // pl
    ],
  ],
  [
    'new_with_tags',
    [
      'avec etiquette', // fr
      'with tags', // en
      'mit etikett', // de
      'con etiqueta', // es
      'con cartellino', // it
      'nieuw met', // nl: "Nieuw met kaartje"
      'z metka', // pl
    ],
  ],
  [
    'very_good',
    [
      'tres bon', // fr
      'very good', // en
      'sehr gut', // de
      'muy bueno', // es
      'ottime condizioni', // it
      'heel goed', // nl
      'bardzo dobry', // pl
    ],
  ],
  [
    'satisfactory',
    [
      'satisfaisant', // fr
      'satisfactory', // en
      'zufriedenstellend', // de
      'satisfactorio', // es
      'soddisfacent', // it
      'redelijk', // nl
      'zadowalaj', // pl
    ],
  ],
  [
    'good',
    [
      'bon etat', // fr
      'good', // en
      'gut', // de
      'bueno', // es
      'buone condizioni', // it
      'goed', // nl
      'dobry', // pl
    ],
  ],
];

/** Lowercase, accents removed, whitespace collapsed. */
function normalize(label: string): string {
  return stripAccents(label).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The condition behind a localized status label ("Neuf avec étiquette", "Good"...). */
export function conditionFromLabel(label: string | null | undefined): Condition {
  if (!label) return 'unknown';
  const text = normalize(label);
  for (const [condition, patterns] of LABEL_PATTERNS) {
    if (patterns.some((pattern) => text.includes(pattern))) return condition;
  }
  return 'unknown';
}

import type { Condition } from '../model';

/**
 * Vinted `status_id` values, as used by its catalogue filter (`status_ids[]=6`).
 *
 * ASSUMPTION: these ids come from Vinted's public catalogue filter, not from the recon:
 * neither the item page nor the wardrobe payload observed in `vinted-recon.md` carries a numeric
 * id (the wardrobe only has the localized `status` label). The ids are therefore only used when a
 * payload provides one; the localized label below remains the path actually exercised today.
 */
export const STATUS_IDS: Readonly<Record<number, Condition>> = {
  6: 'new_with_tags',
  1: 'new_without_tags',
  2: 'very_good',
  3: 'good',
  4: 'satisfactory',
};

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
  return label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function conditionFromStatusId(statusId: number | string | null | undefined): Condition {
  const id = typeof statusId === 'string' ? Number(statusId) : statusId;
  return (id !== null && id !== undefined && STATUS_IDS[id]) || 'unknown';
}

export function conditionFromLabel(label: string | null | undefined): Condition {
  if (!label) return 'unknown';
  const text = normalize(label);
  for (const [condition, patterns] of LABEL_PATTERNS) {
    if (patterns.some((pattern) => text.includes(pattern))) return condition;
  }
  return 'unknown';
}

export interface ConditionSource {
  statusId?: number | string | null;
  label?: string | null;
}

/** Prefers the numeric `status_id` when the payload has one, then the localized label. */
export function parseCondition(source: ConditionSource): Condition {
  const byId = conditionFromStatusId(source.statusId);
  return byId !== 'unknown' ? byId : conditionFromLabel(source.label);
}

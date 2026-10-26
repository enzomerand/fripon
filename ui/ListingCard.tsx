import { useState } from 'preact/hooks';
import { googleLensUrl } from '../lib/checks/image';
import type { OptionsSection } from '../lib/messages';
import type {
  CheckAction,
  CheckId,
  CheckResult,
  CheckStatus,
  ImageMatch,
  Listing,
  Verdict,
  VerdictLevel,
} from '../lib/model';

export type CardState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; listing: Listing; verdict: Verdict; checks: CheckResult[] };

export interface ListingCardProps {
  state: CardState;
  /** Shown as a "Réessayer" button in the error state when provided. */
  onRetry?: () => void;
  /**
   * Called by the button of a check that has an `action` ("Activer en 2 minutes"...). Without it,
   * such a check shows no button.
   */
  onOpenOptions?: (section: OptionsSection) => void;
  /**
   * Called by the "Lancer la recherche d'image" button of the image row in "Au clic" mode. Without
   * it, that row shows no button.
   */
  onRunImageSearch?: () => void;
}

/** Where each check action that opens the options page leads, and what its button says. */
const OPTIONS_ACTIONS: Record<
  Exclude<CheckAction, 'run_image_search'>,
  { section: OptionsSection; label: string }
> = {
  open_guide: { section: 'guide', label: 'Activer en 2 minutes' },
  open_settings: { section: 'credits', label: 'Voir mes réglages' },
  open_keys: { section: 'keys', label: 'Vérifier ma clé' },
};

const RUN_IMAGE_SEARCH_LABEL = "Lancer la recherche d'image";
/** The row links to the first few matches only: the card is not a results page. */
const MAX_MATCH_LINKS = 3;

export const CHECK_LABELS: Record<CheckId, string> = {
  image: "Recherche de l'image",
  price: 'Prix',
  seller: 'Vendeur',
  photos: 'Photos',
  description: 'Description',
};

export const PRUDENCE_NOTE =
  "Indices, pas certitudes : un vendeur honnête peut revendre un article Shein qu'il a porté.";

const LEVEL_COLOUR: Record<VerdictLevel, 'red' | 'orange' | 'green'> = {
  dropshipping: 'red',
  resold: 'orange',
  review: 'orange',
  clean: 'green',
};

const TAG_COLOUR: Record<CheckStatus, 'bad' | 'mid' | 'ok' | 'off'> = {
  bad: 'bad',
  warn: 'mid',
  ok: 'ok',
  off: 'off',
};

const CHECKS_ID = 'fripon-checks';

function Tag({ check }: { check: CheckResult }) {
  return <span class={`fripon__tag fripon__tag--${TAG_COLOUR[check.status]}`}>{check.tag}</span>;
}

/** The matches the row links to: exact ones first, and only real http(s) links. */
function linkedMatches(check: CheckResult): ImageMatch[] {
  if (check.id !== 'image') return [];
  return [...(check.matches ?? [])]
    .filter((match) => /^https?:\/\//i.test(match.url))
    .sort((a, b) => Number(b.exact) - Number(a.exact))
    .slice(0, MAX_MATCH_LINKS);
}

interface CheckRowProps {
  check: CheckResult;
  listing: Listing;
  onOpenOptions?: (section: OptionsSection) => void;
  onRunImageSearch?: () => void;
}

function CheckRow({ check, listing, onOpenOptions, onRunImageSearch }: CheckRowProps) {
  const photoUrl = listing.photoUrls[0];
  const runSearch = check.action === 'run_image_search' && onRunImageSearch;
  const action =
    check.action && check.action !== 'run_image_search' && onOpenOptions
      ? OPTIONS_ACTIONS[check.action]
      : null;
  const matches = linkedMatches(check);
  const showLens = check.id === 'image' && photoUrl;
  return (
    <li class="fripon__check">
      <div class="fripon__check-head">
        <span>{CHECK_LABELS[check.id]}</span>
        <Tag check={check} />
      </div>
      <p class="fripon__detail">{check.detail}</p>
      {(action || runSearch || matches.length > 0 || showLens) && (
        <div class="fripon__actions">
          {action && (
            <button
              type="button"
              class="fripon__action"
              onClick={() => onOpenOptions?.(action.section)}
            >
              {action.label}
            </button>
          )}
          {runSearch && (
            <button type="button" class="fripon__action" onClick={runSearch}>
              {RUN_IMAGE_SEARCH_LABEL}
            </button>
          )}
          {matches.map((match) => (
            <a
              key={match.url}
              class="fripon__link"
              href={match.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Voir sur {match.platform}
            </a>
          ))}
          {showLens && (
            <a
              class="fripon__link"
              href={googleLensUrl(photoUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Chercher moi-même sur Google Lens
            </a>
          )}
        </div>
      )}
    </li>
  );
}

type ResultProps = Extract<CardState, { status: 'done' }> &
  Pick<ListingCardProps, 'onOpenOptions' | 'onRunImageSearch'>;

function Result({ listing, verdict, checks, onOpenOptions, onRunImageSearch }: ResultProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section
      class={`fripon fripon--${LEVEL_COLOUR[verdict.level]}`}
      aria-label={`Fripon : ${verdict.title}`}
    >
      <div class="fripon__title">
        <span class="fripon__dot" aria-hidden="true" />
        {verdict.title}
      </div>
      {verdict.lines.map((line) => (
        <p class="fripon__line" key={line}>
          {line}
        </p>
      ))}
      <button
        type="button"
        class="fripon__toggle"
        aria-expanded={expanded}
        aria-controls={CHECKS_ID}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Masquer les vérifications' : `Voir les ${checks.length} vérifications`}
      </button>
      {expanded && (
        <div id={CHECKS_ID}>
          <ul class="fripon__checks">
            {checks.map((check) => (
              <CheckRow
                key={check.id}
                check={check}
                listing={listing}
                onOpenOptions={onOpenOptions}
                onRunImageSearch={onRunImageSearch}
              />
            ))}
          </ul>
          <p class="fripon__foot">{PRUDENCE_NOTE}</p>
        </div>
      )}
    </section>
  );
}

export function ListingCard({ state, onRetry, onOpenOptions, onRunImageSearch }: ListingCardProps) {
  if (state.status === 'loading') {
    return (
      <section class="fripon fripon--neutral" role="status">
        <span class="fripon__pulse">🦊 Fripon analyse l'annonce…</span>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section class="fripon fripon--neutral" role="status">
        <div class="fripon__title">🦊 Fripon n'a pas pu analyser cette annonce.</div>
        <p class="fripon__line">{state.message}</p>
        {onRetry && (
          <button type="button" class="fripon__toggle" onClick={onRetry}>
            Réessayer
          </button>
        )}
      </section>
    );
  }
  return <Result {...state} onOpenOptions={onOpenOptions} onRunImageSearch={onRunImageSearch} />;
}

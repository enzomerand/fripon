import { useState } from 'preact/hooks';
import { googleLensUrl } from '../lib/checks/image';
import type {
  CheckId,
  CheckResult,
  CheckStatus,
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
}

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

function CheckRow({ check, listing }: { check: CheckResult; listing: Listing }) {
  const photoUrl = listing.photoUrls[0];
  return (
    <li class="fripon__check">
      <div class="fripon__check-head">
        <span>{CHECK_LABELS[check.id]}</span>
        <Tag check={check} />
      </div>
      <p class="fripon__detail">{check.detail}</p>
      {check.id === 'image' && photoUrl && (
        <a
          class="fripon__link"
          href={googleLensUrl(photoUrl)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Chercher moi-même sur Google Lens
        </a>
      )}
    </li>
  );
}

function Result({ listing, verdict, checks }: Extract<CardState, { status: 'done' }>) {
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
              <CheckRow key={check.id} check={check} listing={listing} />
            ))}
          </ul>
          <p class="fripon__foot">{PRUDENCE_NOTE}</p>
        </div>
      )}
    </section>
  );
}

export function ListingCard({ state, onRetry }: ListingCardProps) {
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
  return <Result {...state} />;
}

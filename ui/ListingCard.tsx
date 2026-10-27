import { useState } from 'preact/hooks';
import type { AiBlock } from '../lib/ai/block';
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
} from '../lib/model';
import { LEVEL_COLOUR } from './verdict-colour';

export type CardState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      listing: Listing;
      verdict: Verdict;
      checks: CheckResult[];
      /** The AI review block of the expanded card; without it the card says nothing of the AI. */
      ai?: AiBlock;
    };

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
   * Called by the buttons that run the paid steps: "Lancer la recherche d'image" of the image row in
   * "Au clic" mode (it starts the AI review too), the retry of a failed search, and "Lancer l'avis
   * IA" when there is no image search button to start the review along with. Without it, those
   * buttons are not shown.
   */
  onRun?: () => void;
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
const RUN_AI_REVIEW_LABEL = "Lancer l'avis IA";
const AI_BLOCK_TITLE = "L'avis de l'IA";
const AI_NOTE = 'Résumé par Gemini, il peut se tromper.';
const AI_RUNNING = "L'IA lit l'annonce…";

/** "Voir sur Shein" for a copy of the photo, "Photo proche sur Temu" for a lookalike. */
function matchLinkLabel(match: ImageMatch): string {
  return match.exact ? `Voir sur ${match.platform}` : `Photo proche sur ${match.platform}`;
}
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

/** The "Au clic" button, and the retry button of a failed search: both run the image search. */
function RunSearchButton({ check, onRun }: { check: CheckResult; onRun: () => void }) {
  return (
    <button type="button" class="fripon__action" onClick={onRun}>
      {check.actionLabel ?? RUN_IMAGE_SEARCH_LABEL}
    </button>
  );
}

interface AiReviewBlockProps {
  ai: AiBlock;
  onRun?: () => void;
  onOpenOptions?: (section: OptionsSection) => void;
}

/** "L'avis de l'IA": the summary, with the reminder that it can be wrong. */
function AiReviewBlock({ ai, onRun, onOpenOptions }: AiReviewBlockProps) {
  return (
    <div class="fripon__ai" role="group" aria-label={AI_BLOCK_TITLE}>
      <div class="fripon__ai-title">{AI_BLOCK_TITLE}</div>
      {ai.status === 'running' && (
        <p class="fripon__ai-text" role="status">
          <span class="fripon__pulse">{AI_RUNNING}</span>
        </p>
      )}
      {ai.status === 'done' && (
        <>
          <p class="fripon__ai-text">{ai.summary}</p>
          <p class="fripon__ai-note">{AI_NOTE}</p>
        </>
      )}
      {ai.status === 'failed' && (
        <>
          <p class="fripon__ai-text">{ai.message}</p>
          {ai.action === 'open_keys' && onOpenOptions && (
            <div class="fripon__actions">
              <button
                type="button"
                class="fripon__action"
                onClick={() => onOpenOptions(OPTIONS_ACTIONS.open_keys.section)}
              >
                {OPTIONS_ACTIONS.open_keys.label}
              </button>
            </div>
          )}
        </>
      )}
      {ai.status === 'waiting' && onRun && (
        <div class="fripon__actions">
          <RunAiReviewButton onRun={onRun} />
        </div>
      )}
    </div>
  );
}

/** The "Au clic" button of the AI review, when no image search button starts it along. */
function RunAiReviewButton({ onRun }: { onRun: () => void }) {
  return (
    <button type="button" class="fripon__action" onClick={onRun}>
      {RUN_AI_REVIEW_LABEL}
    </button>
  );
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
  onRun?: () => void;
}

function CheckRow({ check, listing, onOpenOptions, onRun }: CheckRowProps) {
  const photoUrl = listing.photoUrls[0];
  const runSearch = check.action === 'run_image_search' && onRun;
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
          {runSearch && <RunSearchButton check={check} onRun={runSearch} />}
          {matches.map((match) => (
            <a
              key={match.url}
              class="fripon__link"
              href={match.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {matchLinkLabel(match)}
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
  Pick<ListingCardProps, 'onOpenOptions' | 'onRun'>;

function Result({ listing, verdict, checks, ai, onOpenOptions, onRun }: ResultProps) {
  const [expanded, setExpanded] = useState(false);
  // The collapsed card is all most people see: the button that runs the paid steps must be there
  // too. Once expanded, the image row carries it, or the AI block when there is no image button.
  // One button is enough: the image search button starts the AI review along with it.
  const imageCheck = checks.find((check) => check.id === 'image');
  const imageButton =
    imageCheck?.action === 'run_image_search' && onRun ? (
      <RunSearchButton check={imageCheck} onRun={onRun} />
    ) : null;
  const aiWaiting = ai?.status === 'waiting' && onRun !== undefined;
  const collapsedButton =
    !expanded && (imageButton ?? (aiWaiting ? <RunAiReviewButton onRun={onRun} /> : null));
  const searchButton = collapsedButton ? (
    <div class="fripon__actions">{collapsedButton}</div>
  ) : null;
  const showAi = ai !== undefined && !(ai.status === 'waiting' && imageButton !== null);
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
      {searchButton}
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
          {/* First: the summary is what most people want to read, the rows are the proof. */}
          {showAi && <AiReviewBlock ai={ai} onRun={onRun} onOpenOptions={onOpenOptions} />}
          <ul class="fripon__checks">
            {checks.map((check) => (
              <CheckRow
                key={check.id}
                check={check}
                listing={listing}
                onOpenOptions={onOpenOptions}
                onRun={onRun}
              />
            ))}
          </ul>
          <p class="fripon__foot">{PRUDENCE_NOTE}</p>
        </div>
      )}
    </section>
  );
}

export function ListingCard({ state, onRetry, onOpenOptions, onRun }: ListingCardProps) {
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
  return <Result {...state} onOpenOptions={onOpenOptions} onRun={onRun} />;
}

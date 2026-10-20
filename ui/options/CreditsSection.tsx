import { useEffect, useState } from 'preact/hooks';
import { CREDIT_POLICY, WARN_RATIO, type Usage } from '../../lib/credits';
import { formatCount, formatReset } from '../../lib/format';
import { PROVIDERS, saveSettings, type Provider } from '../../lib/settings';

const CREDIT_TEXT: Record<
  Provider,
  { name: string; unit: string; paidWarning: string; freeTier: string }
> = {
  vision: {
    name: "Recherche d'image",
    unit: 'ce mois-ci',
    paidWarning:
      "Au-delà de l'offre gratuite, Google te facture la recherche d'image (environ 3,50 $ les 1 000).",
    freeTier: "la limite de l'offre gratuite",
  },
  gemini: {
    name: 'Analyse IA',
    unit: "aujourd'hui",
    paidWarning:
      "Si ton projet Gemini a la facturation activée, Google te facture au-delà de l'offre gratuite.",
    freeTier: "la limite la plus basse de l'offre gratuite",
  },
};

interface CreditRowProps {
  provider: Provider;
  usage: Usage;
  now: Date;
  onSaved: () => void;
}

function CreditRow({ provider, usage, now, onSaved }: CreditRowProps) {
  const text = CREDIT_TEXT[provider];
  const { defaultCap } = CREDIT_POLICY[provider];
  const { used, cap, state } = usage;
  const [draft, setDraft] = useState(cap === null ? '' : String(cap));
  const [capError, setCapError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // The "Sans plafond" choice just made, shown until the stored cap catches up (or the save fails).
  const [noCapChosen, setNoCapChosen] = useState<boolean | null>(null);
  const noCap = noCapChosen ?? cap === null;

  // Follows the stored cap (changed in another tab, or just saved).
  useEffect(() => {
    setDraft(cap === null ? '' : String(cap));
    setCapError(false);
    setNoCapChosen(null);
  }, [cap]);

  async function saveCap(next: number | null) {
    try {
      await saveSettings({ caps: { [provider]: next } });
      setSaveError(false);
      onSaved();
    } catch {
      // Back to what is really stored: the page must not show a cap that was lost.
      setDraft(cap === null ? '' : String(cap));
      setNoCapChosen(null);
      setSaveError(true);
    }
  }

  function commitDraft(typed: string) {
    const value = Number(typed);
    if (typed.trim() === '' || !Number.isSafeInteger(value) || value < 1) {
      setCapError(true);
      return;
    }
    setCapError(false);
    if (value !== cap) void saveCap(value);
  }

  const count =
    cap === null
      ? `${text.name} : ${formatCount(used)} ${text.unit} (sans plafond)`
      : `${text.name} : ${formatCount(used)} / ${formatCount(cap)} ${text.unit}`;
  const percent = cap === null ? 0 : Math.min(100, Math.round((used / cap) * 100));
  const showPaidWarning = cap === null || cap > defaultCap;
  const inputId = `cap-${provider}`;

  return (
    <div class="credit" data-provider={provider}>
      <p class="credit__count">{count}</p>
      {cap !== null && (
        <div
          class={`meter meter--${state}`}
          role="progressbar"
          aria-label={`${text.name} : crédits utilisés`}
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.min(used, cap)}
        >
          <div class="meter__fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {state === 'warning' && (
        <p class="status status--warn">
          Tu as utilisé au moins {Math.round(WARN_RATIO * 100)} % de ton plafond.
        </p>
      )}
      {state === 'reached' && (
        <p class="status status--bad">
          Plafond atteint : Fripon se limite aux vérifications gratuites et au lien Google Lens.
        </p>
      )}
      <p class="muted">Remis à zéro {formatReset(usage.resetsAt, now)}.</p>

      <div class="cap">
        <label for={inputId}>Plafond</label>
        <input
          id={inputId}
          class="input input--short"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={draft}
          disabled={noCap}
          aria-invalid={capError}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onChange={(event) => commitDraft(event.currentTarget.value)}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={noCap}
            onChange={(event) => {
              const wantsNoCap = event.currentTarget.checked;
              setNoCapChosen(wantsNoCap);
              void saveCap(wantsNoCap ? null : defaultCap);
            }}
          />
          Sans plafond
        </label>
      </div>
      <p class="muted">
        Par défaut : {formatCount(defaultCap)}, {text.freeTier}.
      </p>
      {capError && (
        <p class="status status--bad" role="status">
          Entre un nombre entier supérieur ou égal à 1.
        </p>
      )}
      {saveError && (
        <p class="status status--bad" role="status">
          Impossible d'enregistrer le plafond. Réessaie dans un instant.
        </p>
      )}
      {showPaidWarning && (
        <p class="callout callout--warn" role="note">
          {text.paidWarning}
        </p>
      )}
    </div>
  );
}

export function CreditsSection({
  usage,
  now,
  onSaved,
}: {
  usage: Record<Provider, Usage>;
  now: Date;
  onSaved: () => void;
}) {
  return (
    <section class="card" id="credits" aria-labelledby="credits-title">
      <h2 id="credits-title">Crédits</h2>
      <p class="muted">
        Un crédit, c'est un appel payant à Google. Fripon les compte ici et s'arrête au plafond. Les
        compteurs repartent de zéro à minuit, heure de Californie, comme chez Google. Le compteur
        est local : il ne voit pas ce que la même clé consomme ailleurs.
      </p>
      {PROVIDERS.map((provider) => (
        <CreditRow
          key={provider}
          provider={provider}
          usage={usage[provider]}
          now={now}
          onSaved={onSaved}
        />
      ))}
    </section>
  );
}

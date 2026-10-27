import { useEffect, useRef, useState } from 'preact/hooks';
import { maskKey } from '../../lib/format';
import type { KeyCheckFailure } from '../../lib/google/key-check';
import { sendMessage } from '../../lib/messages';
import {
  PROVIDERS,
  isPlausibleGoogleKey,
  saveSettings,
  type Provider,
  type Settings,
} from '../../lib/settings';

const PROVIDER_TEXT: Record<Provider, { title: string; help: string }> = {
  vision: {
    title: "Recherche d'image — Google Cloud Vision",
    help: "Retrouve la photo de l'annonce sur Shein, Temu, AliExpress… Google demande une carte bancaire, mais les 1 000 premières recherches de chaque mois sont gratuites.",
  },
  gemini: {
    title: 'Analyse IA — Gemini',
    help: "Écrit l'avis en langage simple de la carte et confirme les photos de catalogue. Pour chaque annonce analysée, la photo, le titre et la description sont envoyés à Google. Offre gratuite, sans carte bancaire.",
  },
};

type Failure = KeyCheckFailure | 'unavailable' | 'storage';

/** What to tell the user for each way a test or a save can fail. */
const FAILURE_TEXT: Record<Failure, string> = {
  invalid:
    "Google refuse cette clé. Vérifie qu'elle est copiée en entier et qu'elle n'a pas de restriction de site web.",
  disabled:
    "L'API n'est pas activée sur ce projet. Active-la dans Google Cloud (voir le guide), puis reteste.",
  restricted:
    'Cette clé est limitée à une autre API : ajoute « Cloud Vision API » (ou « Generative Language API ») à ses restrictions.',
  billing:
    "La facturation n'est pas activée sur ce projet. Google l'exige pour cette API, même dans la limite gratuite (voir le guide).",
  quota:
    'Google indique que la limite de cette clé est atteinte pour le moment. Réessaie plus tard.',
  network: 'Impossible de joindre Google. Vérifie ta connexion, puis réessaie.',
  // The test never ran (no answer from the background).
  unavailable: "Fripon n'a pas pu lancer le test. Recharge l'extension, puis réessaie.",
  // The key could not be written to the browser's storage.
  storage: "Impossible d'enregistrer la clé. Réessaie dans un instant.",
};

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'ok' }
  | { kind: 'failed'; reason: Failure };

interface KeyBlockProps {
  provider: Provider;
  saved: string;
  onSaved: () => void;
}

function KeyBlock({ provider, saved, onSaved }: KeyBlockProps) {
  const [draft, setDraft] = useState(saved);
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const lastSaved = useRef(saved);
  const busy = status.kind === 'busy';
  const inputId = `key-${provider}`;
  const text = PROVIDER_TEXT[provider];

  // A change made elsewhere (another tab) shows up, unless the user is in the middle of typing.
  useEffect(() => {
    setDraft((current) => (current === lastSaved.current ? saved : current));
    lastSaved.current = saved;
  }, [saved]);

  const fieldProps = {
    id: inputId,
    class: 'input',
    name: `${provider}-key`,
    value: draft,
    placeholder: 'AIza…',
    autoComplete: 'off',
    autoCapitalize: 'off',
    spellcheck: false,
    onInput: (event: { currentTarget: HTMLInputElement }) => setDraft(event.currentTarget.value),
  } as const;

  const typed = draft.trim();
  const showPlausibleWarning = typed !== '' && !isPlausibleGoogleKey(typed);

  /** Writes the typed key if it differs from the saved one. Rejects when storage fails. */
  async function persist() {
    if (typed === saved) return;
    const next = await saveSettings({ keys: { [provider]: typed } });
    lastSaved.current = next.keys[provider];
    setDraft(next.keys[provider]);
    onSaved();
  }

  async function save() {
    setStatus({ kind: 'busy', text: 'Enregistrement…' });
    try {
      await persist();
      setStatus({ kind: 'info', text: typed === '' ? 'Clé effacée.' : 'Clé enregistrée.' });
    } catch {
      setStatus({ kind: 'failed', reason: 'storage' });
    }
  }

  async function test() {
    if (typed === '') {
      setStatus({ kind: 'info', text: "Colle d'abord ta clé dans le champ ci-dessus." });
      return;
    }
    setStatus({ kind: 'busy', text: 'Test en cours…' });
    // The typed candidate is tested as it is: a saved key that works must never be replaced by
    // one that may not. It is saved only once Google accepts it (or with "Enregistrer").
    const result = await sendMessage({ type: 'testKey', provider, key: typed }).catch(
      () => undefined,
    );
    if (!result) {
      setStatus({ kind: 'failed', reason: 'unavailable' });
      return;
    }
    if (!result.ok) {
      setStatus({ kind: 'failed', reason: result.reason });
      return;
    }
    try {
      await persist();
      setStatus({ kind: 'ok' });
    } catch {
      setStatus({ kind: 'failed', reason: 'storage' });
    }
  }

  async function clear() {
    setStatus({ kind: 'busy', text: 'Suppression…' });
    try {
      const next = await saveSettings({ keys: { [provider]: '' } });
      lastSaved.current = next.keys[provider];
      setDraft('');
      setReveal(false);
      onSaved();
      setStatus({ kind: 'info', text: 'Clé effacée.' });
    } catch {
      setStatus({ kind: 'failed', reason: 'storage' });
    }
  }

  return (
    <div class="key" data-provider={provider}>
      <h3 class="key__title">
        <label for={inputId}>{text.title}</label>
      </h3>
      <p class="muted">{text.help}</p>
      <div class="key__field">
        {/* Two literal types: Preact's input typings do not accept a "text" | "password" union. */}
        {reveal ? <input {...fieldProps} type="text" /> : <input {...fieldProps} type="password" />}
        <button
          type="button"
          class="button button--ghost"
          aria-pressed={reveal}
          onClick={() => setReveal(!reveal)}
        >
          Afficher la clé
        </button>
      </div>
      {saved !== '' && (
        <p class="muted key__saved">
          Clé enregistrée : <code>{maskKey(saved)}</code>
        </p>
      )}
      {showPlausibleWarning && (
        <p class="status status--warn" role="note">
          Cette clé ne ressemble pas à une clé Google (elle commence par « AIza » et fait 39
          caractères). Tu peux l'enregistrer quand même.
        </p>
      )}
      <div class="key__actions">
        <button
          type="button"
          class="button button--primary"
          disabled={busy || typed === saved}
          onClick={() => void save()}
        >
          Enregistrer
        </button>
        <button type="button" class="button" disabled={busy} onClick={() => void test()}>
          Tester
        </button>
        <button
          type="button"
          class="button button--danger"
          disabled={busy || (saved === '' && draft === '')}
          onClick={() => void clear()}
        >
          Effacer
        </button>
      </div>
      <p class={`status ${statusClass(status)}`} role="status" aria-live="polite">
        {statusText(status)}
      </p>
    </div>
  );
}

function statusClass(status: Status): string {
  if (status.kind === 'ok') return 'status--ok';
  if (status.kind === 'failed') return 'status--bad';
  return '';
}

function statusText(status: Status): string {
  switch (status.kind) {
    case 'idle':
      return '';
    case 'busy':
    case 'info':
      return status.text;
    case 'ok':
      return '✓ Clé valide';
    case 'failed':
      return FAILURE_TEXT[status.reason];
  }
}

export function KeysSection({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  return (
    <section class="card" id="keys" aria-labelledby="keys-title">
      <h2 id="keys-title">Tes clés Google</h2>
      <p class="muted">
        Tes clés restent dans ce navigateur et ne servent qu'à appeler Google, jamais un serveur de
        Fripon. Il en faut une par service ; aucune n'est obligatoire pour les vérifications
        gratuites.
      </p>
      {PROVIDERS.map((provider) => (
        <KeyBlock
          key={provider}
          provider={provider}
          saved={settings.keys[provider]}
          onSaved={onSaved}
        />
      ))}
    </section>
  );
}

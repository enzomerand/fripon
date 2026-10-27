import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type {
  CloudStatus,
  CloudUsage,
  DeleteAccountResult,
  LinkResult,
  PriceKey,
  RequestCodeResult,
  VerifyResult,
} from '../../lib/cloud/types';
import { formatCount } from '../../lib/format';
import { sendMessage } from '../../lib/messages';

/**
 * What the Fripon server does with an analysis, said once for the section and the guide: what is
 * sent, to whom, what Google does with it, what is kept and for how long, who else is involved, and
 * that the account can be deleted. One paragraph each; keep the README in step.
 */
export const CLOUD_PRIVACY: readonly string[] = [
  "Avec l'abonnement, l'adresse de la photo, le titre, la description, le prix et les indices calculés par Fripon sont envoyés au serveur de Fripon, qui appelle Google avec sa propre clé payante (Google ne les utilise pas pour améliorer ses produits).",
  "Le serveur garde ton adresse e-mail, l'état de ton abonnement et la liste des photos analysées (2 mois au plus). Les résultats d'une recherche de photo sont gardés 35 jours, ceux d'un avis de l'IA 7 jours. Ton adresse IP, tronquée, reste 7 jours dans les journaux du serveur web, et l'application n'en garde qu'une empreinte (hash) pendant 24 h, pour limiter les abus. Une empreinte de ton adresse e-mail est gardée 12 mois, même si tu supprimes ton compte, pour qu'un essai gratuit ne serve qu'une fois.",
  "Fripon s'appuie sur Google (l'analyse), Stripe (le paiement), un service d'envoi d'e-mails (les codes de connexion) et un hébergeur.",
  'Tu peux supprimer ton compte et son historique depuis cette page.',
];

const OFFERS: { price: PriceKey; label: string }[] = [
  { price: 'essentiel_monthly', label: 'Essentiel — 2,99 €/mois' },
  { price: 'essentiel_yearly', label: 'Essentiel — 29,99 €/an' },
  { price: 'revendeur_monthly', label: 'Revendeur — 6,99 €/mois' },
];

const PLAN_NAMES = { essentiel: 'Essentiel', revendeur: 'Revendeur' } as const;

/** Stripe pages open from the background; the options page then follows the account for a while. */
const WATCH_EVERY_MS = 5_000;
const WATCH_FOR_MS = 120_000;

const NETWORK_TEXT = 'Impossible de joindre Fripon. Vérifie ta connexion, puis réessaie.';
const LOST_TEXT = "Fripon n'a pas pu lancer la demande. Recharge l'extension, puis réessaie.";
const TOO_MANY_TEXT = "Trop d'essais. Réessaie dans quelques minutes.";

const CODE_TEXT: Record<Extract<RequestCodeResult, { ok: false }>['reason'], string> = {
  invalid_email: "Cette adresse e-mail n'a pas l'air valide.",
  rate_limited: TOO_MANY_TEXT,
  mail_unavailable: 'Envoi impossible pour le moment. Réessaie dans quelques minutes.',
  network: NETWORK_TEXT,
};

const VERIFY_TEXT: Record<Extract<VerifyResult, { ok: false }>['reason'], string> = {
  invalid_code: 'Code invalide ou expiré. Vérifie les 6 chiffres, ou demande un nouveau code.',
  rate_limited: TOO_MANY_TEXT,
  network: NETWORK_TEXT,
};

const EXPIRED_TEXT = 'Ta session a expiré. Reconnecte-toi pour continuer.';
const DELETED_TEXT = "Ton compte Fripon et l'historique de tes analyses ont été supprimés.";
const DELETE_CONFIRM_TEXT =
  "Supprimer définitivement ton compte Fripon et ton historique d'analyses ? Tes factures restent chez Stripe.";

const DELETE_TEXT: Record<Extract<DeleteAccountResult, { ok: false }>['reason'], string> = {
  signed_out: 'Ta session a expiré : reconnecte-toi.',
  active_subscription:
    "Résilie d'abord ton abonnement (Gérer mon abonnement). Tu pourras supprimer ton compte une fois la période payée terminée.",
  rate_limited: TOO_MANY_TEXT,
  unavailable: 'Impossible de supprimer ton compte pour le moment. Réessaie dans un instant.',
  network: NETWORK_TEXT,
};

const LINK_TEXT: Record<Extract<LinkResult, { ok: false }>['reason'], string> = {
  signed_out: 'Ta session a expiré : reconnecte-toi.',
  no_customer: 'Aucun abonnement à gérer pour ce compte.',
  rate_limited: TOO_MANY_TEXT,
  unavailable: "Impossible d'ouvrir la page de paiement. Réessaie dans un instant.",
  network: NETWORK_TEXT,
};

/** What a code looks like once the spaces a mail client or a paste adds are gone. */
const digitsOf = (text: string) => text.replace(/\D/g, '');

type Notice = { kind: 'info' | 'error'; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p
      class={`status ${notice?.kind === 'error' ? 'status--bad' : ''}`}
      role="status"
      aria-live="polite"
    >
      {notice?.text ?? ''}
    </p>
  );
}

function SignedOut({
  expiredEmail,
  deleted,
  onChanged,
}: {
  /** The address of a session that expired: the form starts from it. */
  expiredEmail: string | null;
  /** The account was just deleted from this page. */
  deleted: boolean;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState(expiredEmail ?? '');
  const [code, setCode] = useState('');
  // The address the code was sent to: the form moves on to the code once it is set.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(
    deleted ? { kind: 'info', text: DELETED_TEXT } : null,
  );

  async function requestCode() {
    const typed = email.trim();
    if (typed === '') {
      setNotice({ kind: 'error', text: CODE_TEXT.invalid_email });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', text: 'Envoi du code…' });
    const result = await sendMessage({ type: 'cloudRequestCode', email: typed }).catch(
      () => undefined,
    );
    setBusy(false);
    if (!result) {
      setNotice({ kind: 'error', text: LOST_TEXT });
    } else if (!result.ok) {
      setNotice({ kind: 'error', text: CODE_TEXT[result.reason] });
    } else {
      setSentTo(typed);
      setCode('');
      setNotice({
        kind: 'info',
        text: `Un code à 6 chiffres vient d'être envoyé à ${typed}. Il est valable 10 minutes.`,
      });
    }
  }

  async function verify() {
    const digits = digitsOf(code);
    if (sentTo === null || digits.length !== 6) {
      setNotice({ kind: 'error', text: VERIFY_TEXT.invalid_code });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', text: 'Connexion…' });
    const result = await sendMessage({ type: 'cloudVerify', email: sentTo, code: digits }).catch(
      () => undefined,
    );
    setBusy(false);
    if (!result) {
      setNotice({ kind: 'error', text: LOST_TEXT });
    } else if (!result.ok) {
      setNotice({ kind: 'error', text: VERIFY_TEXT[result.reason] });
    } else {
      // The background has stored the session: the section follows the status it wrote.
      setNotice(null);
      onChanged();
    }
  }

  return (
    <>
      {expiredEmail !== null && (
        <p class="status status--warn" role="status">
          {EXPIRED_TEXT}
        </p>
      )}
      <p class="muted">
        Pas envie de créer des clés Google ? Abonne-toi : Fripon s'occupe de la recherche d'image et
        de l'avis IA. 15 analyses offertes pour essayer.
      </p>
      {sentTo === null ? (
        <form
          class="cloud__form"
          onSubmit={(event) => {
            event.preventDefault();
            void requestCode();
          }}
        >
          <label for="cloud-email">Ton adresse e-mail</label>
          <div class="cloud__field">
            <input
              id="cloud-email"
              class="input"
              type="email"
              name="email"
              value={email}
              placeholder="toi@exemple.fr"
              autoComplete="email"
              autoCapitalize="off"
              spellcheck={false}
              onInput={(event) => setEmail(event.currentTarget.value)}
            />
            <button type="submit" class="button button--primary" disabled={busy}>
              Recevoir un code
            </button>
          </div>
        </form>
      ) : (
        <form
          class="cloud__form"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <label for="cloud-code">Code reçu par e-mail</label>
          <div class="cloud__field">
            <input
              id="cloud-code"
              class="input input--code"
              type="text"
              name="code"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={12}
              onInput={(event) => setCode(event.currentTarget.value)}
            />
            <button type="submit" class="button button--primary" disabled={busy}>
              Me connecter
            </button>
          </div>
          <div class="cloud__actions">
            <button
              type="button"
              class="button button--ghost"
              disabled={busy}
              onClick={() => void requestCode()}
            >
              Renvoyer le code
            </button>
            <button
              type="button"
              class="button button--ghost"
              disabled={busy}
              onClick={() => {
                setSentTo(null);
                setCode('');
                setNotice(null);
              }}
            >
              Changer d'adresse
            </button>
          </div>
        </form>
      )}
      <NoticeLine notice={notice} />
    </>
  );
}

/** "Essai : 12 analyses restantes", "Essentiel", "Revendeur", "Aucun abonnement". */
function planLine(usage: CloudUsage): string {
  switch (usage.kind) {
    case 'plan':
      return usage.plan ? PLAN_NAMES[usage.plan] : 'Abonnement';
    case 'trial':
      return `Essai : ${formatCount(usage.trialLeft)} ${usage.trialLeft > 1 ? 'analyses restantes' : 'analyse restante'}`;
    case 'none':
      return 'Aucun abonnement';
  }
}

function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const percent = Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));
  const state = used >= cap ? 'reached' : percent >= 80 ? 'warning' : 'ok';
  return (
    <div class="cloud__meter">
      <p class="credit__count">
        {formatCount(used)} / {formatCount(cap)} {label}
      </p>
      <div
        class={`meter meter--${state}`}
        role="progressbar"
        aria-label={`Analyses utilisées ${label}`}
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
      >
        <div class="meter__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function SignedIn({
  status,
  onChanged,
  onDeleted,
}: {
  status: CloudStatus;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { usage, subscription } = status;
  const hasPlan = usage?.kind === 'plan';
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // After a Stripe page was opened: the account is read again every few seconds for a while, as
  // the plan only shows once Stripe has told the server.
  const [watching, setWatching] = useState(false);
  // "Supprimer mon compte" asks once more before it does anything.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const askDelete = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // The control that replaces the one the keyboard was on takes the focus: the safe answer of the
  // confirmation, and the button again after a cancel.
  useEffect(() => {
    if (confirmingDelete) cancelDelete.current?.focus();
    else if (wasConfirming.current) askDelete.current?.focus();
    wasConfirming.current = confirmingDelete;
  }, [confirmingDelete]);

  // The latest callback, so that `refresh` (and the effects that use it) never changes.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  /** Asks the server again; the answer lands in the stored status, which this page follows. */
  const refresh = useCallback(async () => {
    await sendMessage({ type: 'cloudStatus' }).catch(() => undefined);
    changed.current();
  }, []);

  useEffect(() => {
    void refresh();
    // Back from the Stripe tab (or from a night away): the figures are probably not what they were.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!watching) return;
    const every = setInterval(() => void refresh(), WATCH_EVERY_MS);
    const stop = setTimeout(() => setWatching(false), WATCH_FOR_MS);
    return () => {
      clearInterval(every);
      clearTimeout(stop);
    };
  }, [watching, refresh]);

  useEffect(() => {
    if (hasPlan) setWatching(false);
  }, [hasPlan]);

  async function openStripe(
    message: { type: 'cloudCheckout'; price: PriceKey } | { type: 'cloudPortal' },
  ) {
    setBusy(true);
    setNotice({ kind: 'info', text: 'Ouverture de la page de paiement…' });
    const result = await sendMessage(message).catch(() => undefined);
    setBusy(false);
    if (!result) {
      setNotice({ kind: 'error', text: LOST_TEXT });
    } else if (!result.ok) {
      setNotice({ kind: 'error', text: LINK_TEXT[result.reason] });
    } else {
      setNotice({
        kind: 'info',
        text:
          message.type === 'cloudCheckout'
            ? "La page de paiement s'ouvre dans un nouvel onglet. Reviens ici ensuite : ton abonnement apparaît en quelques secondes."
            : "La page de ton abonnement s'ouvre dans un nouvel onglet.",
      });
      if (message.type === 'cloudCheckout') setWatching(true);
    }
  }

  async function signOut() {
    setBusy(true);
    await sendMessage({ type: 'cloudSignOut' }).catch(() => undefined);
    setBusy(false);
    onChanged();
  }

  async function deleteAccount() {
    setBusy(true);
    setNotice({ kind: 'info', text: 'Suppression du compte…' });
    const result = await sendMessage({ type: 'cloudDeleteAccount' }).catch(() => undefined);
    setBusy(false);
    if (result?.ok) {
      // The background has cleared the session: the section follows the status it removed.
      onDeleted();
      onChanged();
      return;
    }
    setConfirmingDelete(false);
    setNotice({ kind: 'error', text: result ? DELETE_TEXT[result.reason] : LOST_TEXT });
  }

  async function update() {
    setBusy(true);
    setNotice(null);
    await refresh();
    setBusy(false);
  }

  return (
    <>
      <div class="cloud__who">
        <p class="cloud__email">
          Connecté : <strong>{status.email}</strong>
        </p>
        <button
          type="button"
          class="button button--ghost"
          disabled={busy}
          onClick={() => void signOut()}
        >
          Me déconnecter
        </button>
      </div>

      <div class="cloud__plan">
        <p class="credit__count" data-testid="plan">
          {usage ? planLine(usage) : 'Abonnement pas encore lu'}
        </p>
        {usage?.kind === 'none' && subscription === null && (
          <p class="muted">Tes analyses offertes sont utilisées. Abonne-toi pour continuer.</p>
        )}
        {subscription?.status === 'past_due' && (
          <p class="status status--warn">
            Ton dernier paiement n'a pas abouti : mets ta carte à jour dans « Gérer mon abonnement
            ».
          </p>
        )}
        {usage?.kind === 'plan' && usage.month.cap !== null && (
          <Meter label="ce mois-ci" used={usage.month.used} cap={usage.month.cap} />
        )}
        {usage?.kind === 'plan' && usage.day.cap !== null && (
          <Meter label="aujourd'hui" used={usage.day.used} cap={usage.day.cap} />
        )}
        <p class="muted">
          1 analyse = 1 annonce analysée (recherche d'image + avis de l'IA). Revoir la même annonce
          dans le mois ne compte pas.
        </p>
        <button
          type="button"
          class="button button--ghost cloud__refresh"
          disabled={busy}
          onClick={() => void update()}
        >
          Actualiser
        </button>
      </div>

      <div class="cloud__offers">
        {hasPlan ? (
          <button
            type="button"
            class="button"
            disabled={busy}
            onClick={() => void openStripe({ type: 'cloudPortal' })}
          >
            Gérer mon abonnement
          </button>
        ) : (
          OFFERS.map(({ price, label }, index) => (
            <button
              key={price}
              type="button"
              class={`button ${index === 0 ? 'button--primary' : ''}`}
              disabled={busy}
              onClick={() => void openStripe({ type: 'cloudCheckout', price })}
            >
              {label}
            </button>
          ))
        )}
      </div>
      <NoticeLine notice={notice} />

      <div class="cloud__delete">
        {confirmingDelete ? (
          <div class="callout" role="group" aria-label="Supprimer mon compte">
            <p>{DELETE_CONFIRM_TEXT}</p>
            <div class="cloud__actions">
              <button
                type="button"
                class="button button--danger"
                disabled={busy}
                onClick={() => void deleteAccount()}
              >
                Oui, supprimer
              </button>
              <button
                ref={cancelDelete}
                type="button"
                class="button"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={askDelete}
            type="button"
            class="button button--ghost button--danger"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
          >
            Supprimer mon compte
          </button>
        )}
      </div>
    </>
  );
}

export function CloudSection({
  status,
  expired,
  onChanged,
}: {
  status: CloudStatus | null;
  /** The address of a subscription whose session expired, null when it did not. */
  expired: { email: string } | null;
  onChanged: () => void;
}) {
  // Only for this visit: a deleted account leaves nothing to remember it by.
  const [deleted, setDeleted] = useState(false);
  // The notice is about the account that was just deleted: a new sign-in ends it, so that signing
  // out later does not say the account was deleted again.
  useEffect(() => {
    if (status) setDeleted(false);
  }, [status]);
  return (
    <section class="card" id="cloud" aria-labelledby="cloud-title">
      <h2 id="cloud-title">Abonnement Fripon</h2>
      {status ? (
        <SignedIn status={status} onChanged={onChanged} onDeleted={() => setDeleted(true)} />
      ) : (
        <SignedOut expiredEmail={expired?.email ?? null} deleted={deleted} onChanged={onChanged} />
      )}
      <div class="cloud__privacy">
        {CLOUD_PRIVACY.map((paragraph) => (
          <p class="muted" key={paragraph}>
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  );
}

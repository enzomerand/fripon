import type { Mailer } from './mailer';

/**
 * Owner alerts: a plain e-mail to `OWNER_EMAIL` when something only the owner can fix happens (a
 * refused Google key, two paid subscriptions on one account, a webhook that fails, a dispute, a
 * global ceiling reached). At most one e-mail per kind per hour, kept in memory: a restart may
 * send one again, and a revoked key cannot flood the inbox.
 *
 * The text is scrubbed before it leaves: no key, no token, no full address (a photo URL is the
 * seller's), whatever the caller put in it.
 */
export type Alert = (kind: string, text: string) => void;

/** One e-mail per kind within this time. */
export const ALERT_EVERY_MS = 60 * 60 * 1000;

/** What must never reach an e-mail, replaced by a placeholder. */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /\bAIza[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+\S+/gi,
];

/** A web address, cut down to its host: the path and the query belong to a person's listing or session. */
const ADDRESS = /https?:\/\/([^\s/?#]+)[^\s]*/gi;

/** A long run of token characters: a session token, a hash, whatever looks like a secret. */
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/** The text with keys, bearer tokens, long tokens and the path of every address removed. */
export function scrub(text: string): string {
  let clean = text.replace(ADDRESS, (_match, host: string) => `https://${host}/...`);
  for (const shape of SECRET_SHAPES) clean = clean.replace(shape, '[removed]');
  return clean.replace(LONG_TOKEN, '[removed]');
}

export interface AlertDeps {
  mailer: Pick<Mailer, 'sendAlert'>;
  /** `OWNER_EMAIL`; empty in development, where nothing is sent. */
  ownerEmail: string;
  now: () => number;
}

export function createAlerts({ mailer, ownerEmail, now }: AlertDeps): Alert {
  const lastSent = new Map<string, number>();

  return (kind, text) => {
    if (ownerEmail === '') return;
    const at = now();
    const before = lastSent.get(kind);
    if (before !== undefined && at - before < ALERT_EVERY_MS) return;
    // Recorded before the send: a mail server that is down must not be hit at every request.
    lastSent.set(kind, at);

    mailer.sendAlert(ownerEmail, `[Fripon Cloud] ${kind}`, scrub(text)).catch((error: unknown) => {
      // Never the text: only that the alert could not be sent.
      console.error(
        `[alert] could not send the "${kind}" alert:`,
        error instanceof Error ? error.message : error,
      );
    });
  };
}

import { isRecord } from '../json';

/**
 * What the Fripon Cloud server says about an account. Copied from the server's `usageSummary`
 * (`server/src/quota.ts`, `GET /v1/me`) on purpose: the extension never imports from `server/`.
 * Everything read from the server is parsed here before it is used.
 */

export type PlanName = 'essentiel' | 'revendeur';
export const PLAN_NAMES: readonly PlanName[] = ['essentiel', 'revendeur'];

/** The prices that `POST /v1/billing/checkout` takes (Stripe price lookup keys). */
export type PriceKey = 'essentiel_monthly' | 'essentiel_yearly' | 'revendeur_monthly';
export const PRICE_KEYS: readonly PriceKey[] = [
  'essentiel_monthly',
  'essentiel_yearly',
  'revendeur_monthly',
];

/** A counter and its cap. */
export interface UsageWindow {
  used: number;
  /** null when the account has no cap there (the trial has none). */
  cap: number | null;
}

export type UsageKind = 'plan' | 'trial' | 'none';

/** What `/v1/me` and every search answer say about the analyses of the account. */
export interface CloudUsage {
  kind: UsageKind;
  /** Only for `kind: 'plan'`. */
  plan?: PlanName;
  month: UsageWindow;
  day: UsageWindow;
  /** Analyses left of the free trial. */
  trialLeft: number;
}

export interface CloudSubscription {
  /** Stripe's status word (`active`, `past_due`, `canceled`...). */
  status: string;
  periodEnd: number | null;
}

/**
 * What the extension remembers of the account, without the token: what the options page shows and
 * what the gates are made of. `usage` is null until the server has been asked once.
 */
export interface CloudStatus {
  email: string;
  usage: CloudUsage | null;
  subscription: CloudSubscription | null;
  /** When `usage` was last read from the server (ms since the epoch), 0 when it never was. */
  checkedAt: number;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseWindow(raw: unknown): UsageWindow | null {
  if (!isRecord(raw) || !isCount(raw.used)) return null;
  if (raw.cap !== null && !isCount(raw.cap)) return null;
  return { used: raw.used, cap: raw.cap };
}

/** null for anything that is not what the server sends. */
export function parseUsage(raw: unknown): CloudUsage | null {
  if (!isRecord(raw)) return null;
  const { kind, plan } = raw;
  if (kind !== 'plan' && kind !== 'trial' && kind !== 'none') return null;
  const month = parseWindow(raw.month);
  const day = parseWindow(raw.day);
  if (!month || !day || !isCount(raw.trialLeft)) return null;
  const usage: CloudUsage = { kind, month, day, trialLeft: raw.trialLeft };
  if (kind === 'plan') {
    // A plan this version does not know cannot be shown or counted: read as no usage at all.
    if (!PLAN_NAMES.includes(plan as PlanName)) return null;
    usage.plan = plan as PlanName;
  }
  return usage;
}

/** `null` for no subscription, undefined for something that is not a subscription. */
function parseSubscription(raw: unknown): CloudSubscription | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.status !== 'string') return undefined;
  const periodEnd = raw.periodEnd;
  if (periodEnd !== null && periodEnd !== undefined && !isCount(periodEnd)) return undefined;
  return { status: raw.status, periodEnd: periodEnd ?? null };
}

/** The answer of `GET /v1/me`, null when it is not usable. */
export function parseMe(
  raw: unknown,
): { email: string; usage: CloudUsage; subscription: CloudSubscription | null } | null {
  if (!isRecord(raw) || typeof raw.email !== 'string' || raw.email === '') return null;
  const usage = parseUsage(raw);
  const subscription = parseSubscription(raw.subscription);
  if (!usage || subscription === undefined) return null;
  return { email: raw.email, usage, subscription };
}

/** What `storage.local` holds as the status: null for anything this version did not write. */
export function parseStatus(raw: unknown): CloudStatus | null {
  if (!isRecord(raw) || typeof raw.email !== 'string' || raw.email === '') return null;
  if (!isCount(raw.checkedAt)) return null;
  const usage = raw.usage === null ? null : parseUsage(raw.usage);
  const subscription = parseSubscription(raw.subscription);
  if ((usage === null && raw.usage !== null) || subscription === undefined) return null;
  return { email: raw.email, usage, subscription, checkedAt: raw.checkedAt };
}

/** The result of asking the server for a sign-in code. */
export type RequestCodeResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_email' | 'rate_limited' | 'mail_unavailable' | 'network' };

/** The result of sending the code back. On success the session is stored, never returned. */
export type VerifyResult =
  { ok: true } | { ok: false; reason: 'invalid_code' | 'rate_limited' | 'network' };

/** The result of opening a Stripe page (checkout or customer portal) in a new tab. */
export type LinkResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'signed_out' | 'no_customer' | 'rate_limited' | 'unavailable' | 'network';
    };

/**
 * The result of deleting the account (`DELETE /v1/account`). On success the session is gone here
 * too. `active_subscription` (409): the subscription must end first.
 */
export type DeleteAccountResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'signed_out' | 'active_subscription' | 'rate_limited' | 'unavailable' | 'network';
    };

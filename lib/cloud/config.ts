/**
 * Where the Fripon Cloud server lives. The single place that names it: the manifest's host
 * permissions (`wxt.config.ts`) and every request of `client.ts` read it from here. The domain is
 * not final.
 */
export const CLOUD_ORIGIN = 'https://fripon.endurance.tools';

/**
 * The image search and the AI review wait for what the server waits for: its photo download (10 s)
 * plus Vision (20 s) or Gemini (30 s). A shorter timeout here would show a network error for an
 * analysis the account is charged for.
 */
export const CLOUD_SLOW_TIMEOUT_MS = 45_000;
/** Everything else (sign-in, status, billing links). */
export const CLOUD_TIMEOUT_MS = 10_000;

/** The account status is read again at most this often to answer a gate. */
export const STATUS_MAX_AGE_MS = 60_000;
/** After the server refused an analysis, the status is read again at most this often. */
export const STATUS_AFTER_REFUSAL_MS = 10_000;

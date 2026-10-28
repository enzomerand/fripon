/** What `/healthz` reports besides the database: whether the owner's own keys (Google, Anthropic) work. */
export interface Health {
  /** The server's key for this service was refused (or its project has no billing, quota...) just now. */
  ownerProblem(service: 'vision' | 'gemini' | 'claude'): void;
  /** The services whose owner key had a problem in the last `OWNER_PROBLEM_WINDOW_MS`, sorted. */
  degraded(): string[];
}

/** An owner-key problem keeps `/healthz` at 503 for this long after the last time it was seen. */
export const OWNER_PROBLEM_WINDOW_MS = 10 * 60 * 1000;

export function createHealth(now: () => number): Health {
  const seen = new Map<string, number>();
  return {
    ownerProblem(service) {
      seen.set(service, now());
    },
    degraded() {
      const since = now() - OWNER_PROBLEM_WINDOW_MS;
      return [...seen]
        .filter(([, at]) => at > since)
        .map(([service]) => service)
        .sort();
    },
  };
}

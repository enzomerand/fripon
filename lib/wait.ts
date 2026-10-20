export interface WaitOptions {
  /** Gives up (resolving null) after this long. */
  timeoutMs: number;
  /** Probes are coalesced: at most one per this delay while the DOM keeps changing. */
  checkDelayMs?: number;
}

/** Default delay between two probes while the page streams in. */
export const DEFAULT_CHECK_DELAY_MS = 50;

/**
 * Resolves with the first truthy value `probe` returns, checking now and after DOM changes
 * (Vinted streams its page, so elements can show up long after `document_idle`). Resolves with
 * null on timeout. A probe that throws is treated as "not yet".
 */
export function waitFor<T>(
  probe: () => T | null | undefined | false,
  options: WaitOptions,
): Promise<T | null> {
  const { timeoutMs, checkDelayMs = DEFAULT_CHECK_DELAY_MS } = options;

  return new Promise((resolve) => {
    let settled = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      scheduled ??= setTimeout(check, checkDelayMs);
    });

    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(scheduled);
      clearTimeout(deadline);
      resolve(value);
    };

    const check = () => {
      scheduled = undefined;
      try {
        const value = probe();
        if (value) finish(value);
      } catch {
        // Not ready yet: keep waiting.
      }
    };

    const deadline = setTimeout(() => finish(null), timeoutMs);
    check();
    if (settled) return;

    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'data-testid'],
    });
  });
}

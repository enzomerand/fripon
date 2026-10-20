// Calls that share the same name never overlap, wherever they run.
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `task` while holding the lock `name`. The Web Locks API is used when it exists, which
 * serialises across every context of the extension (options page, service worker, even a worker
 * that restarted in the middle of a write). Without it, an in-module promise chain still
 * serialises calls made from this one context.
 */
export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks && typeof locks.request === 'function') return locks.request(name, task);

  const run = (chains.get(name) ?? Promise.resolve()).then(task);
  // A failed task must not block the ones queued behind it.
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}

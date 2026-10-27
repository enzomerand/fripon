/**
 * How long a stop waits for the requests in flight (a Vision call and a Gemini call may each take
 * up to 30 seconds) before it gives up and exits. `compose.yml` gives Docker 5 more seconds
 * (`stop_grace_period: 50s`): this guard must fire first, or Docker would kill the process.
 */
export const SHUTDOWN_TIMEOUT_MS = 45_000;

export interface ShutdownDeps {
  /** The HTTP server: `close` stops accepting and calls back once every request is done. */
  server: { close(callback: () => void): unknown };
  /** What is closed once the requests are done (the database), before the process exits 0. */
  cleanup: () => void;
  exit: (code: number) => void;
  log: (line: string) => void;
  /** Injected so a test needs no real waiting. */
  setTimer?: (callback: () => void, ms: number) => { unref(): unknown };
}

/** Stops taking requests, lets the running ones finish (at most `SHUTDOWN_TIMEOUT_MS`), then cleans up and exits 0. */
export function createShutdown({
  server,
  cleanup,
  exit,
  log,
  setTimer = setTimeout,
}: ShutdownDeps): (signal: string) => void {
  let stopping = false;
  return (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    // A connection kept alive by a client must not hold the container past its stop timeout.
    setTimer(() => {
      log(`requests still running after ${SHUTDOWN_TIMEOUT_MS / 1000} s, exiting anyway`);
      exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => {
      cleanup();
      exit(0);
    });
  };
}

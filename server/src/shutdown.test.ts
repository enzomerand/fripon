import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_TIMEOUT_MS, createShutdown } from './shutdown';

function setup() {
  const server = { close: vi.fn<(callback: () => void) => void>() };
  const cleanup = vi.fn();
  const exit = vi.fn();
  const log = vi.fn();
  const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = [];
  const setTimer = (callback: () => void, ms: number) => {
    const timer = { callback, ms, unref: vi.fn() };
    timers.push(timer);
    return timer;
  };
  const shutdown = createShutdown({ server, cleanup, exit, log, setTimer });
  return { server, cleanup, exit, log, timers, shutdown };
}

describe('graceful shutdown', () => {
  it('waits 45 seconds for the requests in flight before it gives up', () => {
    const { timers, shutdown, exit } = setup();
    shutdown('SIGTERM');

    expect(SHUTDOWN_TIMEOUT_MS).toBe(45_000);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(45_000);
    // The guard must not keep the process alive on its own.
    expect(timers[0]?.unref).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    timers[0]?.callback();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('closes the server, then cleans up and exits 0 once the requests are done', () => {
    const { server, cleanup, exit, shutdown } = setup();
    shutdown('SIGINT');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    server.close.mock.calls[0]?.[0]();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('does nothing the second time a signal arrives', () => {
    const { server, timers, shutdown } = setup();
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);
  });

  it('leaves Docker 5 seconds more than the guard (compose.yml says 50s)', () => {
    const compose = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8');
    const grace = /^\s*stop_grace_period:\s*(\d+)s\s*$/m.exec(compose);
    expect(grace).not.toBeNull();
    expect(Number(grace?.[1]) * 1000).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS + 5_000);
  });
});

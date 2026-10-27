import { describe, expect, it, vi } from 'vitest';
import { ALERT_EVERY_MS, createAlerts, scrub } from './alerts';
import { createHealth, OWNER_PROBLEM_WINDOW_MS } from './health';
import { fakeClock, fakeMailer } from './test-helpers';

function setup(ownerEmail = 'owner@example.com') {
  const mailer = fakeMailer();
  const clock = fakeClock();
  const alert = createAlerts({ mailer, ownerEmail, now: clock.ms });
  return { mailer, clock, alert };
}

describe('createAlerts', () => {
  it('mails the owner a plain text, the kind in the subject', async () => {
    const { mailer, alert } = setup();
    alert('webhook-failure', 'The event evt_1 could not be processed.');
    await vi.waitFor(() => expect(mailer.alerts).toHaveLength(1));
    expect(mailer.alerts[0]).toEqual({
      to: 'owner@example.com',
      subject: '[Fripon Cloud] webhook-failure',
      text: 'The event evt_1 could not be processed.',
    });
  });

  it('sends one mail per kind per hour, and each kind has its own hour', async () => {
    const { mailer, clock, alert } = setup();
    alert('a', 'one');
    alert('a', 'two');
    alert('b', 'three');
    clock.advance(ALERT_EVERY_MS - 1);
    alert('a', 'four');
    await vi.waitFor(() => expect(mailer.alerts).toHaveLength(2));
    expect(mailer.alerts.map((sent) => sent.text)).toEqual(['one', 'three']);

    clock.advance(1);
    alert('a', 'five');
    await vi.waitFor(() => expect(mailer.alerts).toHaveLength(3));
    expect(mailer.alerts[2]?.text).toBe('five');
  });

  it('sends nothing without an owner address (development)', async () => {
    const { mailer, alert } = setup('');
    alert('a', 'one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mailer.alerts).toEqual([]);
  });

  it('survives a mail server that is down: it logs the kind and the reason, never the text, and does not retry at once', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mailer = { sendAlert: vi.fn().mockRejectedValue(new Error('smtp down')) };
    const clock = fakeClock();
    const alert = createAlerts({ mailer, ownerEmail: 'owner@example.com', now: clock.ms });

    alert('a', 'the secret text');
    alert('a', 'the secret text');
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));

    expect(mailer.sendAlert).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0])).toContain('"a"');
    expect(String(log.mock.calls[0])).toContain('smtp down');
    expect(String(log.mock.calls[0])).not.toContain('the secret text');
    log.mockRestore();
  });

  it('never sends a key, a token or a full photo address, whatever the caller wrote', async () => {
    const { mailer, alert } = setup();
    alert(
      'leak',
      [
        'Vision key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
        'stripe sk_live_51Habcdefghijklmnop and rk_test_abc123 and whsec_abcdef123456',
        'header Authorization: Bearer abc.def-ghi_jkl',
        'session token 0123456789abcdefghijklmnopqrstuvwxyzABCDEF-_',
        'photo https://images1.vinted.net/t/01_00a1b/f800/1234567890.jpeg?s=sig1 failed',
        'kept: evt_1Abc and sub_1Abc and 42 calls',
      ].join('\n'),
    );
    await vi.waitFor(() => expect(mailer.alerts).toHaveLength(1));
    const { text } = mailer.alerts[0]!;

    for (const secret of [
      'AIzaSy',
      'sk_live',
      'rk_test',
      'whsec_abc',
      'abc.def-ghi',
      '0123456789abcdef',
      '/t/01_00a1b',
      '1234567890.jpeg',
      's=sig1',
    ]) {
      expect(text).not.toContain(secret);
    }
    // What the owner needs stays: the host, the ids, the numbers.
    expect(text).toContain('https://images1.vinted.net/...');
    expect(text).toContain('evt_1Abc and sub_1Abc and 42 calls');
  });
});

describe('scrub', () => {
  it('leaves an ordinary sentence alone', () => {
    const line = 'The global Vision ceiling of 3000 calls a day (Pacific time) is reached.';
    expect(scrub(line)).toBe(line);
  });
});

describe('createHealth', () => {
  it('names the services whose owner key had a problem in the last 10 minutes', () => {
    const clock = fakeClock();
    const health = createHealth(clock.ms);
    expect(health.degraded()).toEqual([]);

    health.ownerProblem('vision');
    clock.advance(OWNER_PROBLEM_WINDOW_MS - 1);
    expect(health.degraded()).toEqual(['vision']);
    health.ownerProblem('gemini');
    expect(health.degraded()).toEqual(['gemini', 'vision']);

    clock.advance(1);
    expect(health.degraded()).toEqual(['gemini']);
    clock.advance(OWNER_PROBLEM_WINDOW_MS);
    expect(health.degraded()).toEqual([]);
  });

  it('starts the ten minutes again at each new sighting', () => {
    const clock = fakeClock();
    const health = createHealth(clock.ms);
    health.ownerProblem('vision');
    clock.advance(OWNER_PROBLEM_WINDOW_MS - 1);
    health.ownerProblem('vision');
    clock.advance(OWNER_PROBLEM_WINDOW_MS - 1);
    expect(health.degraded()).toEqual(['vision']);
  });
});

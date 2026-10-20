import { describe, expect, it } from 'vitest';
import { waitFor } from './wait';

const options = { timeoutMs: 300, checkDelayMs: 5 };

describe('waitFor', () => {
  it('resolves at once when the probe already succeeds', async () => {
    await expect(waitFor(() => 'ready', options)).resolves.toBe('ready');
  });

  it('resolves once an element is added later', async () => {
    setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="late">hi</p>'), 20);
    const found = await waitFor(() => document.querySelector('#late'), options);
    expect(found?.textContent).toBe('hi');
    found?.remove();
  });

  it('resolves null on timeout', async () => {
    await expect(waitFor(() => null, { timeoutMs: 30, checkDelayMs: 5 })).resolves.toBeNull();
  });

  it('keeps waiting while the probe throws', async () => {
    let ready = false;
    const probe = () => {
      if (!ready) throw new Error('not yet');
      return 'ok';
    };
    const marker = document.createElement('span');
    setTimeout(() => {
      ready = true;
      document.body.append(marker);
    }, 20);
    await expect(waitFor(probe, options)).resolves.toBe('ok');
    marker.remove();
  });
});

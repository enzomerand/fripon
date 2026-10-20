import { describe, expect, it } from 'vitest';
import { waitFor } from './wait';

const options = { timeoutMs: 300, checkDelayMs: 5 };

describe('waitFor', () => {
  it('resolves at once when the probe already succeeds', async () => {
    await expect(waitFor(() => 'ready', options)).resolves.toBe('ready');
  });

  it('resolves once an element is added later', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    setTimeout(() => root.insertAdjacentHTML('beforeend', '<p id="late">hi</p>'), 20);
    const found = await waitFor(() => root.querySelector('#late'), { ...options, root });
    expect(found?.textContent).toBe('hi');
    root.remove();
  });

  it('resolves null on timeout', async () => {
    await expect(waitFor(() => null, { timeoutMs: 30, checkDelayMs: 5 })).resolves.toBeNull();
  });

  it('keeps waiting while the probe throws', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    let ready = false;
    const probe = () => {
      if (!ready) throw new Error('not yet');
      return 'ok';
    };
    setTimeout(() => {
      ready = true;
      root.append(document.createElement('span'));
    }, 20);
    await expect(waitFor(probe, { ...options, root })).resolves.toBe('ok');
    root.remove();
  });
});

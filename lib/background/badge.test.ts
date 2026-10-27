import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BADGES, DEFAULT_TITLE, setToolbarBadge, type ToolbarButton } from './badge';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('BADGES', () => {
  it('maps each level to a mark and a colour', () => {
    expect(BADGES).toEqual({
      dropshipping: { text: '!', colour: '#d93025' },
      resold: { text: '?', colour: '#b45309' },
      review: { text: '?', colour: '#b45309' },
      clean: { text: '✓', colour: '#188038' },
    });
  });
});

describe('setToolbarBadge', () => {
  const button = () => browser.action;

  it('shows the mark, the colour and the title for the tab only', async () => {
    await setToolbarBadge(button(), 7, { level: 'dropshipping', title: 'Dropshipping probable' });
    expect(await browser.action.getBadgeText({ tabId: 7 })).toBe('!');
    expect(await browser.action.getBadgeBackgroundColor({ tabId: 7 })).toEqual([217, 48, 37, 255]);
    expect(await browser.action.getTitle({ tabId: 7 })).toBe('Fripon — Dropshipping probable');
    // Another tab, and the button as a whole, are left alone.
    expect(await browser.action.getBadgeText({ tabId: 8 })).toBe('');
    expect(await browser.action.getBadgeText({})).toBe('');
  });

  it('replaces the badge of a tab with the next verdict', async () => {
    await setToolbarBadge(button(), 7, { level: 'dropshipping', title: 'Dropshipping probable' });
    await setToolbarBadge(button(), 7, { level: 'clean', title: 'Rien de suspect' });
    expect(await browser.action.getBadgeText({ tabId: 7 })).toBe('✓');
    expect(await browser.action.getBadgeBackgroundColor({ tabId: 7 })).toEqual([24, 128, 56, 255]);
    expect(await browser.action.getTitle({ tabId: 7 })).toBe('Fripon — Rien de suspect');
  });

  it('clears the badge and gives the title back for null', async () => {
    await setToolbarBadge(button(), 7, { level: 'review', title: 'À vérifier' });
    await setToolbarBadge(button(), 7, null);
    expect(await browser.action.getBadgeText({ tabId: 7 })).toBe('');
    expect(await browser.action.getTitle({ tabId: 7 })).toBe(DEFAULT_TITLE);
  });

  it('does nothing without a toolbar button', async () => {
    await expect(
      setToolbarBadge(undefined, 7, { level: 'clean', title: 'Rien de suspect' }),
    ).resolves.toBeUndefined();
  });

  it('never rejects, and one call failing leaves the others', async () => {
    const fails = vi.fn(() => Promise.reject(new Error('No tab with id: 7.')));
    const setTitle = vi.fn();
    const closedTab: ToolbarButton = {
      setBadgeText: fails,
      setBadgeBackgroundColor: () => {
        throw new Error('not supported');
      },
      setTitle,
    };
    await expect(
      setToolbarBadge(closedTab, 7, { level: 'clean', title: 'Rien de suspect' }),
    ).resolves.toBeUndefined();
    expect(fails).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith({ title: 'Fripon — Rien de suspect', tabId: 7 });
  });
});

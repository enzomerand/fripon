import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { VerdictLevel } from '../model';
import { badgeFor, badgeTitle, DEFAULT_TITLE, setToolbarBadge, type ToolbarButton } from './badge';

const LEVELS: VerdictLevel[] = ['dropshipping', 'resold', 'review', 'clean'];

beforeEach(() => {
  fakeBrowser.reset();
});

describe('badgeFor', () => {
  it('maps each level to a mark and a colour', () => {
    expect(badgeFor('dropshipping')).toEqual({ text: '!', colour: '#d93025' });
    expect(badgeFor('resold')).toEqual({ text: '?', colour: '#b45309' });
    expect(badgeFor('review')).toEqual({ text: '?', colour: '#b45309' });
    expect(badgeFor('clean')).toEqual({ text: '✓', colour: '#188038' });
  });

  it('gives every level a short mark and a colour of the form #rrggbb', () => {
    for (const level of LEVELS) {
      const { text, colour } = badgeFor(level);
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(2);
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('badgeTitle', () => {
  it('puts the verdict title after the extension name', () => {
    expect(badgeTitle({ level: 'dropshipping', title: 'Dropshipping probable' })).toBe(
      'Fripon — Dropshipping probable',
    );
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

  it('tolerates a button that lacks a method', async () => {
    const partial = { setTitle: vi.fn() } as unknown as ToolbarButton;
    await expect(setToolbarBadge(partial, 7, null)).resolves.toBeUndefined();
    expect(partial.setTitle).toHaveBeenCalledWith({ title: DEFAULT_TITLE, tabId: 7 });
  });
});

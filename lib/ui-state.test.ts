import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_UI_STATE, UI_STATE_KEY, loadUiState, parseUiState, saveUiState } from './ui-state';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('parseUiState', () => {
  it.each([undefined, null, 3, 'x', [], { welcomeDismissed: 'yes' }])(
    'gives the defaults for %j',
    (raw) => {
      expect(parseUiState(raw)).toEqual(DEFAULT_UI_STATE);
    },
  );

  it('reads a valid object', () => {
    expect(parseUiState({ welcomeDismissed: true })).toEqual({ welcomeDismissed: true });
  });
});

describe('loadUiState / saveUiState', () => {
  it('starts with the welcome banner not dismissed', async () => {
    expect(await loadUiState()).toEqual({ welcomeDismissed: false });
  });

  it('stores { welcomeDismissed: true } under fripon:ui:v1', async () => {
    expect(await saveUiState({ welcomeDismissed: true })).toEqual({ welcomeDismissed: true });
    expect((await browser.storage.local.get(UI_STATE_KEY))[UI_STATE_KEY]).toEqual({
      welcomeDismissed: true,
    });
    expect(UI_STATE_KEY).toBe('fripon:ui:v1');
    expect(await loadUiState()).toEqual({ welcomeDismissed: true });
  });

  it('survives concurrent saves', async () => {
    await Promise.all([saveUiState({}), saveUiState({ welcomeDismissed: true }), saveUiState({})]);
    expect((await loadUiState()).welcomeDismissed).toBe(true);
  });
});

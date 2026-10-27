import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeImageResponse, SearchImageResponse } from '../messages';
import type { ImageMatch } from '../model';
import { imageCheckForMatches } from '../checks/image';
import { checkPhotos } from '../checks/photos';
import {
  compactVerdict,
  quickAnalysis,
  type QuickAnalysisDeps,
  type QuickOutcome,
} from './quick-analysis';

const PHOTO = 'https://images1.vinted.net/t/01_aa/310x430/aa.webp?s=1';

const sheinExact: ImageMatch = {
  platform: 'Shein',
  url: 'https://fr.shein.com/Robe-Test-p-1234567-cat-1727.html',
  exact: true,
  price: null,
};
const temuSimilar: ImageMatch = {
  platform: 'Temu',
  url: 'https://www.temu.com/robe-g-601099512345678.html',
  exact: false,
  price: null,
};

const REAL_PHOTO: AnalyzeImageResponse = { ok: true, hash: '0f0f0f0f0f0f0f0f', catalogScore: 0.1 };
const STUDIO_PHOTO: AnalyzeImageResponse = {
  ok: true,
  hash: '0f0f0f0f0f0f0f0f',
  catalogScore: 0.9,
};

function setup(
  search: SearchImageResponse | Error,
  analysis: AnalyzeImageResponse | Error = REAL_PHOTO,
) {
  const searchImage = vi.fn<QuickAnalysisDeps['searchImage']>(() =>
    search instanceof Error ? Promise.reject(search) : Promise.resolve(search),
  );
  const analyzeImage = vi.fn<QuickAnalysisDeps['analyzeImage']>(() =>
    analysis instanceof Error ? Promise.reject(analysis) : Promise.resolve(analysis),
  );
  const deps: QuickAnalysisDeps = { searchImage, analyzeImage };
  return { deps, searchImage, analyzeImage };
}

const found = (...matches: ImageMatch[]): SearchImageResponse => ({ status: 'ok', matches });

describe('compactVerdict', () => {
  const photos = checkPhotos({ main: null, others: [] });

  it('quotes the platform of the copy of the photo', () => {
    const verdict = compactVerdict(imageCheckForMatches([sheinExact]), photos);
    expect(verdict).toEqual({
      level: 'resold',
      title: 'Article Shein revendu',
      line: 'Shein · analyse rapide',
    });
  });

  it('prefers the exact match whatever the order of the matches', () => {
    const verdict = compactVerdict(imageCheckForMatches([temuSimilar, sheinExact]), photos);
    expect(verdict.line).toBe('Shein · analyse rapide');
  });

  it('quotes the closest page, and asks to check, when the photo is only similar', () => {
    const verdict = compactVerdict(imageCheckForMatches([temuSimilar]), photos);
    expect(verdict).toEqual({
      level: 'review',
      title: 'À vérifier',
      line: 'Temu · analyse rapide',
    });
  });

  it('says nothing was found when the search found nothing', () => {
    const verdict = compactVerdict(imageCheckForMatches([]), photos);
    expect(verdict).toEqual({
      level: 'clean',
      title: 'Rien de suspect',
      line: 'Rien trouvé · analyse rapide',
    });
  });

  it('does not let a catalogue-looking thumbnail change the level on its own', () => {
    const studio = checkPhotos({
      main: { hash: 0x0f0f0f0f0f0f0f0fn, catalogScore: 0.9 },
      others: [],
    });
    expect(studio.signals).toEqual([{ id: 'catalog_photo', strength: 'weak' }]);
    expect(compactVerdict(imageCheckForMatches([]), studio).level).toBe('clean');
    expect(compactVerdict(imageCheckForMatches([sheinExact]), studio).level).toBe('resold');
  });
});

describe('quickAnalysis', () => {
  it('ends in a compact verdict when the search answers', async () => {
    const { deps } = setup(found(sheinExact));
    expect(await quickAnalysis(PHOTO, deps)).toEqual<QuickOutcome>({
      status: 'done',
      verdict: { level: 'resold', title: 'Article Shein revendu', line: 'Shein · analyse rapide' },
    });
  });

  it('searches the thumbnail for real (a click), not only in the cache', async () => {
    const { deps, searchImage } = setup(found());
    await quickAnalysis(PHOTO, deps);
    expect(searchImage).toHaveBeenCalledOnce();
    // `searchPhoto` passes the flags positionally; neither is set.
    expect(searchImage).toHaveBeenCalledWith(PHOTO, false, false);
  });

  it('asks for another attempt when the click follows a failure', async () => {
    const { deps, searchImage } = setup(found());
    await quickAnalysis(PHOTO, deps, true);
    expect(searchImage).toHaveBeenCalledWith(PHOTO, false, true);
  });

  it('looks at the same thumbnail locally, at the same time as the search', async () => {
    const { deps, analyzeImage, searchImage } = setup(found());
    const running = quickAnalysis(PHOTO, deps);
    expect(searchImage).toHaveBeenCalledOnce();
    expect(analyzeImage).toHaveBeenCalledWith(PHOTO);
    await running;
  });

  it('still gives the verdict when the thumbnail cannot be analysed locally', async () => {
    for (const analysis of [{ ok: false, error: 'fetch' } as const, new Error('closed')]) {
      const { deps } = setup(found(temuSimilar), analysis);
      expect(await quickAnalysis(PHOTO, deps)).toMatchObject({
        status: 'done',
        verdict: { level: 'review' },
      });
    }
  });

  it('keeps the level of a copy of the photo for a studio-looking thumbnail', async () => {
    const { deps } = setup(found(sheinExact), STUDIO_PHOTO);
    expect(await quickAnalysis(PHOTO, deps)).toMatchObject({
      status: 'done',
      verdict: { level: 'resold', line: 'Shein · analyse rapide' },
    });
  });

  it('says nothing was found', async () => {
    const { deps } = setup(found());
    expect(await quickAnalysis(PHOTO, deps)).toMatchObject({
      status: 'done',
      verdict: { level: 'clean', line: 'Rien trouvé · analyse rapide' },
    });
  });

  it('asks for the guide when there is no key', async () => {
    const { deps } = setup({ status: 'no_key' });
    expect(await quickAnalysis(PHOTO, deps)).toEqual({ status: 'needsKey', section: 'guide' });
  });

  it.each(['invalid', 'restricted', 'disabled', 'billing'] as const)(
    'sends to the keys when Google refuses the key (%s)',
    async (reason) => {
      const { deps } = setup({ status: 'error', reason });
      expect(await quickAnalysis(PHOTO, deps)).toEqual({ status: 'needsKey', section: 'keys' });
    },
  );

  it('reports the cap', async () => {
    const { deps } = setup({ status: 'quota' });
    expect(await quickAnalysis(PHOTO, deps)).toEqual({ status: 'quota' });
  });

  it.each(['network', 'quota', 'photo', 'unavailable'] as const)(
    'offers to try again after a failed search (%s)',
    async (reason) => {
      const { deps } = setup({ status: 'error', reason });
      expect(await quickAnalysis(PHOTO, deps)).toEqual({
        status: 'error',
        line: 'Recherche impossible',
      });
    },
  );

  it('counts a background that does not answer as a failed search', async () => {
    expect(await quickAnalysis(PHOTO, setup(new Error('closed')).deps)).toMatchObject({
      status: 'error',
    });
    const silent = setup(found());
    silent.searchImage.mockResolvedValue(undefined as unknown as SearchImageResponse);
    expect(await quickAnalysis(PHOTO, silent.deps)).toMatchObject({ status: 'error' });
  });

  it('counts an answer from the cache as a failure: a grid never asks for it', async () => {
    const { deps } = setup({ status: 'not_cached' });
    expect(await quickAnalysis(PHOTO, deps)).toMatchObject({ status: 'error' });
  });

  it('sends nothing when the card has no usable photo', async () => {
    const { deps, searchImage, analyzeImage } = setup(found());
    // Not a failure of the search: nothing was tried.
    expect(await quickAnalysis(null, deps)).toEqual({ status: 'noPhoto' });
    expect(searchImage).not.toHaveBeenCalled();
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});

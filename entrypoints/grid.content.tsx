import { analyzeImageViaBackground, openOptions, searchDeps } from '../lib/background/client';
import { VINTED_ITEM_MATCHES, VINTED_PAGE_MATCHES } from '../lib/vinted/domains';
import { createGridController } from '../ui/grid/controller';
// The CSS is a string: it goes into the shadow roots by hand, one shared sheet for all of them.
import css from '../ui/grid/grid.css?inline';

/**
 * The Fripon button under every result card of the catalogue, the search, a seller's wardrobe and
 * the home feed. Item pages have their own card (`listing.content.tsx`) and are left out.
 */
export default defineContentScript({
  matches: VINTED_PAGE_MATCHES,
  excludeMatches: VINTED_ITEM_MATCHES,
  main(ctx) {
    const grid = createGridController({
      doc: document,
      css,
      deps: { ...searchDeps, analyzeImage: analyzeImageViaBackground },
      openOptions,
    });
    grid.start();
    ctx.onInvalidated(() => grid.dispose());
    // Back / forward can bring the page back from the bfcache with its cards as they were.
    ctx.addEventListener(window, 'pageshow', (event) => {
      if (event.persisted) grid.rescan();
    });
    ctx.addEventListener(window, 'wxt:locationchange', () => grid.rescan());
  },
});

# Fripon

Browser extension (Chrome desktop, Safari macOS, Firefox bonus) that flags dropshipped
(Shein, Temu, AliExpress…) and overpriced Vinted listings. Free, open source, AGPL-3.0.
Design: `docs/superpowers/specs/2026-10-20-fripon-extension-design.md`. Mockups: `docs/mockups/`.

## Commands

- `npm run dev` (Chrome, watch) / `npm run dev:firefox`; `npm run build` -> `.output/chrome-mv3`; `npm run zip`.
- Load by hand: `chrome://extensions` -> Developer mode -> "Load unpacked" -> `.output/chrome-mv3`.
- Safari (macOS only): `npm run build:safari` -> `.output/safari-mv3`; `npm run safari:sync` copies it into the Xcode project; `npm run safari:app` = both + `xcodebuild` Debug, ad-hoc signed -> `.output/safari-xcode/Build/Products/Debug/Fripon.app`. Steps to load it in Safari are in `README.md`.
- `npm run check` = `format:check` + `lint` + `typecheck` + `test` (the local gate, run it before every commit).
- `npm run format` fixes Prettier; `npm test` = `vitest run` (happy-dom + WXT fake browser).
- One test file: `npx vitest run lib/credits.test.ts`; one test: add `-t "name"`.

## Architecture

WXT 0.21 + Preact 11 + TypeScript strict (`noUncheckedIndexedAccess`), Manifest V3.

- `entrypoints/background.ts`: service worker. Answers `lib/messages.ts` requests (`analyzeImage`, `searchImage`, `getImageGate`, `openOptions`, `testKey`), opens the options page (toolbar button, first install). Handler logic is in `lib/background/handlers.ts`.
- `entrypoints/listing.content.tsx`: content script on Vinted item pages. Mounts the card (shadow root UI), reads the listing, runs `lib/analysis.ts`, re-runs on bfcache restore and `wxt:locationchange`. The card shows from the free checks first; then one code path runs the Vision search (automatic mode is a click nobody has to make) and `withImageSearch` redoes the verdict from the stored checks (no new Vinted request). The page sends `searchImage` whatever the gate; in "Au clic" mode it only sends `cacheOnly` by itself.
- `entrypoints/options/` + `ui/options/`: full-tab settings page (mode, keys, credits, guide). `ui/ListingCard.*`: the card.
- `lib/vinted/`: `listing-reader.ts` (JSON-LD + DOM), `selectors.ts` (every selector, one place), `anchor.ts`, `api.ts` (seller fetch: shared request queue spaced 1.5 s across tabs, 24 h cache, cooldown after 403/429).
- `lib/checks/` (image, price, seller, photos, description) -> `lib/verdict.ts`; `lib/analysis.ts` orchestrates the free checks only (the paid search is not part of it); `lib/checks/image-matches.ts` turns Vision `pagesWithMatchingImages` into `ImageMatch[]` (platform allowlist by hostname, `exact` = full match on a product URL); `lib/image/` runs in the background: pixel hashing, `analyzer.ts` (guarded photo fetch, shared), `search.ts` (`searchImage`, cheapest step first: 7-day cache in `search-cache.ts` under `fripon:vision:v1:<origin+path>`, no key, 10-minute memo of a refused key, cap read without reserving, photo download, `reserve`, call; `refund` only when Google certainly did not bill).
- `lib/settings.ts` (`fripon:settings:v1`), `lib/credits.ts` (counters `fripon:credits:v1:<provider>:<period>`, periods and resets on Pacific time like Google, caps from `CREDIT_POLICY`, atomic `reserve`/`refund`), `lib/lock.ts` (`navigator.locks` with an in-module fallback), `lib/gate.ts` (`ready|no_key|quota|manual`), `lib/google/key-check.ts` (free key test, and the Google error classifier `vision.ts` reuses), `lib/google/vision.ts` (`webDetect`, the paid WEB_DETECTION call), `lib/options-nav.ts` (which options section to show, via `storage.session`).

- `safari/Fripon/`: Xcode project (container app + Safari extension target, bundle id `fr.fripon.Fripon`), generated once by `safari-web-extension-converter` and committed. `Fripon Extension/Resources/` is an ignored copy of the WXT build (`scripts/safari-sync.mjs`); `scripts/safari-app.mjs` runs `xcodebuild`. ESLint, Prettier and Vitest skip `safari/`.

## Conventions

- Code, identifiers, comments, commit messages in English. User-facing UI text in French (tutoiement).
- No GitHub Actions, ever (owner's rule). Gates run locally.
- Never commit API keys or `.env` files. BYOK keys live in extension storage only.

## Pitfalls

- Vinted's API needs the header `accept: application/json`, or Cloudflare answers 403 with a challenge page.
- `/api/v2/items/<id>/details` always returns 403: item data comes from JSON-LD + DOM (`listing-reader.ts`).
- Hashed CSS classes change on every Vinted deploy: only `data-testid` and `details-list--*` are stable.
- API keys are only read in the background (and shown on the options page). Content scripts get a gate word, never a key; `testKey` is accepted from extension pages only. Keys go in the `x-goog-api-key` header, never in a URL.
- A Gemini key must come from a Google Cloud project without billing: billing switches Gemini to the paid tier. Vision needs billing, so the two keys need two projects.
- Vinted is not a single-page app (pages reload), but bfcache restores (`pageshow`) and `wxt:locationchange` are handled anyway.
- Paid Google calls (lots 3-4): `reserve` a credit in the background right before each call and `refund` it if the call cost nothing. The gate sent to pages is only a display hint.
- Do not touch existing storage keys (`fripon:seller:v2:*`, `fripon:lastRequestAt:*`, `fripon:cooldownUntil:*`).
- Vinted re-renders the item sidebar ~0.3 s and ~2 s after load: injected nodes must re-attach, and browser tests must inject at DOMContentLoaded, not after load.
- Vision WEB_DETECTION finds Shein catalog photos as many `pagesWithMatchingImages` across shein country hosts (some are category pages): exact = `fullMatchingImages` on a product URL.
- Listing-grid thumbnails often lazy-load placeholders: take `og:image` / JSON-LD photos instead.
- Typed `browser.runtime.getURL('/options.html')` only exists after `wxt prepare`: build the URL from `getURL('/')`.
- Safari: the Xcode project lists each top-level entry of the extension (files one by one, folders as references), so a new top-level file in the build (new HTML entrypoint...) makes `safari:sync` fail until the project is regenerated (README, "Régénérer le projet Xcode"); hashed files inside `chunks/`, `assets/`, `content-scripts/` are fine. The converter also rewrites the French container app text: revert it with version control.
- Safari: no Apple Developer account, so builds are ad-hoc signed and need Develop > "Allow Unsigned Extensions", which Safari resets at every restart. Safari asks the user to allow each site (vinted.*, `*.vinted.net`, Google APIs): without it the card does not show or the photo fetch fails. Safari suspends the service worker quickly: in-memory caches (analyzer, refused-key memo) are only optimisations, anything that must survive lives in `storage.local`. `strict_min_version` 16.4 (Safari build only) comes from `storage.session` and `OffscreenCanvas`.

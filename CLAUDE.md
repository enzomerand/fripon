# Fripon

Browser extension (Chrome desktop, Safari macOS, Firefox bonus) that flags dropshipped
(Shein, Temu, AliExpress…) and overpriced Vinted listings. Free, open source, AGPL-3.0.
Design: `docs/superpowers/specs/2026-10-20-fripon-extension-design.md`. Mockups: `docs/mockups/`.

## Commands

- `npm run dev` (Chrome, watch) / `npm run dev:firefox`; `npm run build` -> `.output/chrome-mv3`; `npm run zip`.
- Load by hand: `chrome://extensions` -> Developer mode -> "Load unpacked" -> `.output/chrome-mv3`.
- `npm run check` = `format:check` + `lint` + `typecheck` + `test` (the local gate, run it before every commit).
- `npm run format` fixes Prettier; `npm test` = `vitest run` (happy-dom + WXT fake browser).
- One test file: `npx vitest run lib/credits.test.ts`; one test: add `-t "name"`.

## Architecture

WXT 0.21 + Preact 11 + TypeScript strict (`noUncheckedIndexedAccess`), Manifest V3.

- `entrypoints/background.ts`: service worker. Answers `lib/messages.ts` requests (`analyzeImage`, `getImageGate`, `openOptions`, `testKey`), opens the options page (toolbar button, first install). Handler logic is in `lib/background/handlers.ts`.
- `entrypoints/listing.content.tsx`: content script on Vinted item pages. Mounts the card (shadow root UI), reads the listing, runs `lib/analysis.ts`, re-runs on bfcache restore and `wxt:locationchange`.
- `entrypoints/options/` + `ui/options/`: full-tab settings page (mode, keys, credits, guide). `ui/ListingCard.*`: the card.
- `lib/vinted/`: `listing-reader.ts` (JSON-LD + DOM), `selectors.ts` (every selector, one place), `anchor.ts`, `api.ts` (seller fetch: shared request queue spaced 1.5 s across tabs, 24 h cache, cooldown after 403/429).
- `lib/checks/` (image, price, seller, photos, description) -> `lib/verdict.ts`; `lib/analysis.ts` orchestrates; `lib/image/` pixel hashing, run in the background.
- `lib/settings.ts` (`fripon:settings:v1`), `lib/credits.ts` (counters `fripon:credits:v1:<provider>:<period>`, local time, caps from `CREDIT_POLICY`), `lib/gate.ts` (`ready|no_key|quota|manual`), `lib/google/key-check.ts` (free key test).

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
- Do not touch existing storage keys (`fripon:seller:v2:*`, `fripon:lastRequestAt:*`, `fripon:cooldownUntil:*`).
- Typed `browser.runtime.getURL('/options.html')` only exists after `wxt prepare`: build the URL from `getURL('/')`.

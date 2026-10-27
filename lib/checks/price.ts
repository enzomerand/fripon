import type { CheckResult, ImageMatch } from '../model';

/**
 * What the price row says when the image search found the photo somewhere. Shein and Temu serve
 * their prices to browsers only (a robot gets an anti-bot page), and the free keys give no way to
 * read them, so Fripon sends the buyer to the links of the image row instead of quoting a price.
 */
export const PRICE_WITH_MATCHES =
  'Shein et Temu cachent leurs prix aux robots : compare toi-même avec les liens ci-dessus.';
/** What it says when there is no original listing to compare with. */
export const PRICE_WITHOUT_MATCHES = "Pas de prix d'origine à comparer.";

/**
 * The price row. Fripon does not compare prices in v1: the original price cannot be read, so the
 * row is `off` and gives no signal, and the verdict never relies on a price ratio. It only tells
 * the buyer what to do, which depends on whether the image search found the photo.
 */
export function priceCheck(imageMatches: ImageMatch[]): CheckResult {
  return {
    id: 'price',
    status: 'off',
    tag: 'Non comparé',
    detail: imageMatches.length > 0 ? PRICE_WITH_MATCHES : PRICE_WITHOUT_MATCHES,
    signals: [],
  };
}

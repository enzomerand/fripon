/**
 * Paid services reached with a Google key. In its own file, free of any browser import, so the
 * Google modules (and the Fripon Cloud server that reuses them) can name it without pulling in
 * the extension's settings storage.
 */
export type Provider = 'vision' | 'gemini';

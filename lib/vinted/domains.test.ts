import { describe, expect, it } from 'vitest';
import { isVintedPageUrl, VINTED_HOSTS, VINTED_ITEM_MATCHES, VINTED_PAGE_MATCHES } from './domains';

describe('VINTED_ITEM_MATCHES', () => {
  it('builds one https www item-page match pattern per host', () => {
    expect(VINTED_ITEM_MATCHES).toHaveLength(VINTED_HOSTS.length);
    expect(VINTED_ITEM_MATCHES).toContain('https://www.vinted.fr/items/*');
    expect(VINTED_ITEM_MATCHES).toContain('https://www.vinted.co.uk/items/*');
    expect(VINTED_ITEM_MATCHES.every((match) => match.endsWith('/items/*'))).toBe(true);
  });
});

describe('VINTED_PAGE_MATCHES', () => {
  it('builds one https www match pattern per host, for every page', () => {
    expect(VINTED_PAGE_MATCHES).toHaveLength(VINTED_HOSTS.length);
    expect(VINTED_PAGE_MATCHES).toContain('https://www.vinted.fr/*');
    expect(VINTED_PAGE_MATCHES).toContain('https://www.vinted.co.uk/*');
  });

  it('covers the same hosts as the item pages, which the grid script excludes', () => {
    const hostsOf = (patterns: string[]) => patterns.map((match) => new URL(match).host);
    expect(hostsOf(VINTED_PAGE_MATCHES)).toEqual(hostsOf(VINTED_ITEM_MATCHES));
  });
});

describe('isVintedPageUrl', () => {
  it('accepts an https page of any Vinted host, with or without www', () => {
    expect(isVintedPageUrl('https://www.vinted.fr/items/1-robe')).toBe(true);
    expect(isVintedPageUrl('https://vinted.fr/')).toBe(true);
    expect(isVintedPageUrl('https://www.vinted.co.uk/catalog?search_text=robe')).toBe(true);
    for (const host of VINTED_HOSTS) {
      expect(isVintedPageUrl(`https://www.${host}/items/1`)).toBe(true);
    }
  });

  it('refuses http, other schemes and other protocols', () => {
    expect(isVintedPageUrl('http://www.vinted.fr/items/1')).toBe(false);
    expect(isVintedPageUrl('chrome-extension://abc/options.html')).toBe(false);
    expect(isVintedPageUrl('ftp://www.vinted.fr/')).toBe(false);
  });

  it('refuses look-alikes, other subdomains and other sites', () => {
    expect(isVintedPageUrl('https://www.vinted.fr.evil.test/items/1')).toBe(false);
    expect(isVintedPageUrl('https://evil.test/www.vinted.fr/items/1')).toBe(false);
    expect(isVintedPageUrl('https://evilvinted.fr/items/1')).toBe(false);
    expect(isVintedPageUrl('https://www.evilvinted.fr/items/1')).toBe(false);
    expect(isVintedPageUrl('https://help.vinted.fr/')).toBe(false);
    expect(isVintedPageUrl('https://www.vinted.xx/items/1')).toBe(false);
    expect(isVintedPageUrl('https://user@www.vinted.fr.evil.test/')).toBe(false);
  });

  it('answers false, and never throws, for anything that is not a URL', () => {
    expect(isVintedPageUrl('')).toBe(false);
    expect(isVintedPageUrl('not a url')).toBe(false);
    expect(isVintedPageUrl('//www.vinted.fr/items/1')).toBe(false);
    expect(isVintedPageUrl(undefined as unknown as string)).toBe(false);
  });
});

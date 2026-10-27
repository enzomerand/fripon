import { describe, expect, it } from 'vitest';
import { VINTED_HOSTS, VINTED_ITEM_MATCHES, VINTED_PAGE_MATCHES } from './domains';

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

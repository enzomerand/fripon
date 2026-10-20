import { describe, expect, it } from 'vitest';
import { VINTED_HOSTS, VINTED_ITEM_MATCHES, VINTED_MATCHES } from './domains';

describe('VINTED_MATCHES', () => {
  it('builds one https www match pattern per host', () => {
    expect(VINTED_MATCHES).toHaveLength(VINTED_HOSTS.length);
    expect(VINTED_MATCHES).toContain('https://www.vinted.fr/*');
    expect(VINTED_MATCHES).toContain('https://www.vinted.co.uk/*');
  });
});

describe('VINTED_ITEM_MATCHES', () => {
  it('restricts every pattern to item pages', () => {
    expect(VINTED_ITEM_MATCHES).toHaveLength(VINTED_MATCHES.length);
    expect(VINTED_ITEM_MATCHES).toContain('https://www.vinted.fr/items/*');
    expect(VINTED_ITEM_MATCHES).toContain('https://www.vinted.co.uk/items/*');
    expect(VINTED_ITEM_MATCHES.every((match) => match.endsWith('/items/*'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { VINTED_HOSTS, VINTED_MATCHES } from './domains';

describe('VINTED_MATCHES', () => {
  it('builds one https www match pattern per host', () => {
    expect(VINTED_MATCHES).toHaveLength(VINTED_HOSTS.length);
    expect(VINTED_MATCHES).toContain('https://www.vinted.fr/*');
    expect(VINTED_MATCHES).toContain('https://www.vinted.co.uk/*');
  });
});

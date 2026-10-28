import { describe, expect, it } from 'vitest';
import { ipPrefix } from './http';

describe('ipPrefix', () => {
  it('leaves an IPv4 address as it is', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('  203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('reads an IPv6 address as its /64 prefix: every address of the block is one client', () => {
    expect(ipPrefix('2001:db8:1234:5678:9abc:def0:1234:5678')).toBe('2001:db8:1234:5678::/64');
    expect(ipPrefix('2001:db8:1234:5678::1')).toBe('2001:db8:1234:5678::/64');
    expect(ipPrefix('2001:db8:1234:5678:ffff:ffff:ffff:ffff')).toBe('2001:db8:1234:5678::/64');
    // The next block is another client.
    expect(ipPrefix('2001:db8:1234:5679::1')).not.toBe(ipPrefix('2001:db8:1234:5678::1'));
  });

  it('writes the prefix the same way however the address is written', () => {
    const prefix = '2001:db8:0:1::/64';
    expect(ipPrefix('2001:db8:0:1:0:0:0:1')).toBe(prefix);
    expect(ipPrefix('2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd')).toBe(prefix);
    expect(ipPrefix('2001:DB8:0:1::2')).toBe(prefix);
    expect(ipPrefix('[2001:db8:0:1::2]')).toBe(prefix);
    expect(ipPrefix('2001:db8:0:1::2%eth0')).toBe(prefix);
  });

  it('reads a short prefix, and the loopback and unspecified addresses', () => {
    expect(ipPrefix('::1')).toBe('0:0:0:0::/64');
    expect(ipPrefix('::')).toBe('0:0:0:0::/64');
    expect(ipPrefix('fe80::1')).toBe('fe80:0:0:0::/64');
    expect(ipPrefix('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address, in either notation', () => {
    expect(ipPrefix('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(ipPrefix('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(ipPrefix('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('gives the same answer for a prefix it already gave (a client address is read once, but safely)', () => {
    const prefix = ipPrefix('2001:db8:1:2:3:4:5:6');
    expect(ipPrefix(prefix)).toBe(prefix);
  });

  it.each(['unknown', '', 'not an address', '1.2.3', '2001:db8:::1', '1:2:3:4:5:6:7:8:9', 'g::1'])(
    'returns %j unchanged: it is not an address',
    (raw) => {
      expect(ipPrefix(raw)).toBe(raw);
    },
  );
});

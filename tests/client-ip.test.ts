import { describe, expect, it } from 'vitest';
import { clientAddress, parseTrustProxy } from '../src/client-ip.js';

describe('client address', () => {
  const disabled = parseTrustProxy('false');
  const loopback = parseTrustProxy('loopback');
  const bridge = parseTrustProxy('172.18.0.1');

  it('ignores a spoofed forwarding header when the proxy is not trusted', () => {
    expect(clientAddress(disabled, '203.0.113.5', '198.51.100.5')).toBe('203.0.113.5');
    expect(clientAddress(loopback, '203.0.113.5', '198.51.100.8')).toBe('203.0.113.5');
    expect(clientAddress(bridge, '172.18.0.2', '203.0.113.9')).toBe('172.18.0.2');
  });

  it('uses one forwarding header from a trusted peer', () => {
    expect(clientAddress(loopback, '127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddress(loopback, '::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    expect(clientAddress(bridge, '172.18.0.1', '203.0.113.10')).toBe('203.0.113.10');
  });

  it('does not trust a list of forwarded addresses', () => {
    expect(clientAddress(loopback, '127.0.0.1', '198.51.100.8, 203.0.113.9')).toBe('127.0.0.1');
  });

  it('falls back to the peer when the header is not a single IP', () => {
    expect(clientAddress(loopback, '127.0.0.1', 'not-an-ip')).toBe('127.0.0.1');
    expect(clientAddress(loopback, '127.0.0.1', '')).toBe('127.0.0.1');
  });

  it('treats a 10/8 network as one trusted source and rejects a worldwide prefix', () => {
    const ten = parseTrustProxy('10.0.0.0/8');
    expect(clientAddress(ten, '10.1.2.3', '203.0.113.4')).toBe('203.0.113.4');
    expect(clientAddress(ten, '11.0.0.1', '203.0.113.4')).toBe('11.0.0.1');
    expect(() => parseTrustProxy('0.0.0.0/0')).toThrow(/8 through 32/);
  });
});

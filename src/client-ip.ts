import { isIP } from 'node:net';

/**
 * Client IP comes from the TCP peer unless that peer is a configured proxy.
 * A trusted proxy must replace X-Forwarded-For with one client address.
 * A list of addresses is ignored, because the left-most value is attacker-controlled
 * when a proxy appends instead of replacing.
 */

export type TrustProxy = { mode: 'disabled' } | { mode: 'list'; entries: TrustEntry[] };

export type TrustEntry =
  | { type: 'loopback' }
  | { type: 'ipv4'; network: number; bits: number }
  | { type: 'ipv6'; address: string };

export function parseTrustProxy(value: string | undefined): TrustProxy {
  const raw = (value ?? '').trim();
  if (raw === '' || /^(false|0|no|off)$/i.test(raw)) return { mode: 'disabled' };
  if (/^(true|1|yes|on)$/i.test(raw)) {
    throw new Error(
      'TRUST_PROXY cannot be true. Name the proxy instead, for example loopback or 172.18.0.1.',
    );
  }
  const entries: TrustEntry[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    if (/^loopback$/i.test(item)) {
      entries.push({ type: 'loopback' });
      continue;
    }
    entries.push(parseAddressOrCidr(item));
  }
  if (entries.length === 0) throw new Error('TRUST_PROXY is empty.');
  return { mode: 'list', entries };
}

export function clientAddress(
  trust: TrustProxy,
  remoteAddress: string | null | undefined,
  forwardedFor: string | null | undefined,
): string {
  const peer = normalizeIp(remoteAddress);
  if (!peer) return 'unknown';
  if (trust.mode === 'disabled' || !isTrustedPeer(trust, peer)) return peer;
  return singleForwardedAddress(forwardedFor) ?? peer;
}

export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  if (isIP(ip) === 4) return ip;
  if (isIP(lower) === 6) return lower;
  return null;
}

function parseAddressOrCidr(value: string): TrustEntry {
  if (value.includes(':')) {
    if (value.includes('/')) {
      throw new Error(`TRUST_PROXY does not accept an IPv6 range (${value}). Use an exact IPv6 address or loopback.`);
    }
    const address = normalizeIp(value);
    if (!address || isIP(address) !== 6) throw new Error(`TRUST_PROXY has an invalid address: ${value}`);
    return { type: 'ipv6', address };
  }
  const [base, bitsText] = value.split('/');
  if (!base || value.split('/').length > 2) throw new Error(`TRUST_PROXY has an invalid address: ${value}`);
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 8 || bits > 32) {
    throw new Error(`TRUST_PROXY prefix for ${value} must be from 8 through 32 so it cannot trust the whole internet.`);
  }
  const network = ipv4ToInt(base);
  if (network === null) throw new Error(`TRUST_PROXY has an invalid address: ${value}`);
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return { type: 'ipv4', network: (network & mask) >>> 0, bits };
}

function isTrustedPeer(trust: Extract<TrustProxy, { mode: 'list' }>, peer: string): boolean {
  return trust.entries.some((entry) => matchesEntry(entry, peer));
}

function matchesEntry(entry: TrustEntry, peer: string): boolean {
  if (entry.type === 'loopback') {
    if (peer === '::1') return true;
    const value = ipv4ToInt(peer);
    if (value === null) return false;
    return (value >>> 24) === 127;
  }
  if (entry.type === 'ipv6') return peer === entry.address;
  const value = ipv4ToInt(peer);
  if (value === null) return false;
  const mask = (0xffffffff << (32 - entry.bits)) >>> 0;
  return ((value & mask) >>> 0) === entry.network;
}

function singleForwardedAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length !== 1) return null;
  return normalizeIp(parts[0]);
}

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  const d = parts[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((a * 2 ** 24) + (b * 2 ** 16) + (c * 2 ** 8) + d) >>> 0;
}

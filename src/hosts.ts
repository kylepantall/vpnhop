import { isIPv4 } from 'node:net';

const ipv4ToInt = (ip: string) => ip.split('.').reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (!base || !isIPv4(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** `*`, exact host, `*.suffix` (subdomains only), or IPv4 CIDR. Case-insensitive. */
export function hostAllowed(host: string, patterns: string[] | undefined): boolean {
  if (!patterns) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (p === '*') return true;
    if (p.includes('/')) return isIPv4(h) && inCidr(h, p);
    if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

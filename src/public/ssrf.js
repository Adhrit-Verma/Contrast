// A public URL-scanner is a classic SSRF vector: without this, anyone could
// paste http://169.254.169.254/ (cloud metadata) or an internal service
// address and have OUR server fetch it on their behalf from inside our own
// network. In THIS deployment specifically, that also includes our own
// Tailscale range (100.64.0.0/10) — the admin dashboard from Step 5 lives
// there with no auth beyond tailnet membership, so a visitor pasting a
// tailnet address must be refused too, not just RFC1918 ranges.
import { promises as dns } from 'node:dns';

const PRIVATE_V4 = [
  [/^127\./, 'loopback'],
  [/^10\./, 'private (RFC1918)'],
  [/^192\.168\./, 'private (RFC1918)'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private (RFC1918)'],
  [/^169\.254\./, 'link-local (cloud metadata lives here)'],
  [/^0\./, 'unspecified/reserved'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'carrier-grade NAT / Tailscale range'],
];

function classifyV4(ip) {
  for (const [re, why] of PRIVATE_V4) if (re.test(ip)) return why;
  return null;
}

function classifyV6(ip) {
  const low = ip.toLowerCase();
  if (low === '::1') return 'loopback';
  if (/^fe[89ab]/.test(low)) return 'link-local';
  if (/^f[cd]/.test(low)) return 'unique local (private)';
  if (low.startsWith('::ffff:')) return classifyV4(low.slice(7));
  return null;
}

/** @returns {string|null} why the address is unsafe, or null if it's public */
export function classifyAddress(ip, family) {
  return family === 6 ? classifyV6(ip) : classifyV4(ip);
}

/**
 * Resolve a URL's hostname and refuse anything that resolves to a private,
 * loopback, link-local, or CGNAT/Tailscale address.
 * ponytail: checks the INITIAL resolution only — a DNS-rebinding attack (the
 * name resolves safely here, then to a private IP by the time Chrome actually
 * connects) is a known, real gap. Closing it fully needs a network-level guard
 * (a resolving proxy, or pinning the resolved IP into the request) — worth
 * doing before this tool sees real hostile traffic at scale, not needed for a
 * first public funnel with per-IP rate limiting and a low page cap already
 * bounding the blast radius.
 * @returns {Promise<string>} the normalised href, if it passes
 */
export async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');

  let addresses;
  try {
    addresses = await dns.lookup(u.hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`could not resolve ${u.hostname}: ${err.message}`);
  }
  for (const { address, family } of addresses) {
    const why = classifyAddress(address, family);
    if (why) throw new Error(`${u.hostname} resolves to a ${why} address (${address}) — not scannable from a public tool`);
  }
  return u.href;
}

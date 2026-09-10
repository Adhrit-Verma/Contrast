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

/** @returns {Promise<string|null>} why the host is unsafe, or null if it is fine */
export async function hostProblem(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return `could not resolve ${hostname}: ${err.message}`;
  }
  // EVERY answer must be public. A name that returns one public and one private
  // address is not safe — the browser may pick either.
  for (const { address, family } of addresses) {
    const why = classifyAddress(address, family);
    if (why) return `${hostname} resolves to a ${why} address (${address})`;
  }
  return null;
}

/**
 * Re-checks every host the browser actually reaches, not just the one the
 * visitor typed.
 *
 * `assertPublicUrl()` runs once, before navigation. It cannot see a redirect
 * to an internal address, a subresource pointing at cloud metadata, or a name
 * whose DNS answer changes after the check. This guard runs on each request,
 * which closes the first two outright and narrows the third to the gap between
 * our resolve and Chrome's connect.
 *
 * Answers are cached per scan: a page pulls dozens of subresources from a
 * handful of hosts, and re-resolving each one would add latency for nothing.
 */
export function createHostGuard({ ttlMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new Map(); // hostname -> { why, at }
  return async function checkHost(hostname) {
    const hit = cache.get(hostname);
    if (hit && now() - hit.at < ttlMs) return hit.why;
    const why = await hostProblem(hostname);
    cache.set(hostname, { why, at: now() });
    return why;
  };
}

/**
 * Resolve a URL's hostname and refuse anything that resolves to a private,
 * loopback, link-local, or CGNAT/Tailscale address. The first gate; the
 * per-request guard above is the one that survives a redirect.
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

  const why = await hostProblem(u.hostname);
  if (why) throw new Error(`${why} — not scannable from a public tool`);
  return u.href;
}

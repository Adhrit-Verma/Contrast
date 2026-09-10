// Read-only guard. Two separate concerns, deliberately:
//   - requestRule(): applies to EVERY request the page makes (incl. XHR/fetch).
//     Blocks state-changing methods and denylisted URLs. Allowlist is NOT applied
//     here — subresources (CSS, fonts, images, CDNs) must still load.
//   - inCrawlScope(): applies only to URLs the crawler chooses to navigate to.
//
// List matching is case-insensitive substring on `pathname + search`.
// Over-blocking is the safe direction; do not make this clever.

const SAFE_METHODS = new Set(['GET', 'HEAD']);

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).toLowerCase();
  } catch {
    return null;
  }
};

const matches = (list, path) => list.some((p) => path.includes(p.toLowerCase()));

/** @returns {null | string} null = allow, string = reason it was blocked */
export function requestRule(url, method, { denylist = [] } = {}) {
  if (!SAFE_METHODS.has(method?.toUpperCase())) return `method ${method}`;
  const path = pathOf(url);
  if (path === null) return null; // data:/blob: — not navigable state changes
  if (matches(denylist, path)) return 'denylisted url';
  return null;
}

/** @returns {null | string} null = in scope, string = reason it was skipped */
export function inCrawlScope(url, originUrl, { denylist = [], allowlist = [], skipExtensions = [] } = {}) {
  let u, origin;
  try {
    u = new URL(url);
    origin = new URL(originUrl);
  } catch {
    return 'unparseable';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'non-http';
  if (u.origin !== origin.origin) return 'cross-origin';

  const path = (u.pathname + u.search).toLowerCase();
  const ext = u.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (ext && skipExtensions.map((e) => e.toLowerCase()).includes(ext)) return `extension ${ext}`;
  if (matches(denylist, path)) return 'denylisted url';
  if (allowlist.length && !matches(allowlist, path)) return 'outside allowlist';
  return null;
}

/** Strip the fragment — /a#x and /a are the same page to a crawler. */
export function canonical(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Attach the read-only interceptor to a page. MUST NOT be attached during the
 * manual login flow — the auditor's credential POST would be blocked.
 *
 * `hostCheck` is optional and async: given a hostname it returns a reason to
 * refuse, or null. The public scanner supplies one so that a redirect or a
 * subresource pointing at an internal address is refused at request time —
 * the initial URL check cannot see either. Nothing is passed on the admin
 * path, where the operator chose the target themselves.
 *
 * @param {import('puppeteer').Page} page
 * @param {(hostname: string) => Promise<string|null>} [hostCheck]
 */
export async function attachReadOnlyGuard(page, crawlCfg, onBlocked = () => {}, hostCheck = null) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const reason = requestRule(req.url(), req.method(), crawlCfg);
    if (reason) {
      onBlocked(req.url(), req.method(), reason);
      req.abort('blockedbyclient').catch(() => {});
      return;
    }
    if (hostCheck) {
      let host = null;
      try { host = new URL(req.url()).hostname; } catch { /* data:/blob: — no host to check */ }
      if (host) {
        // Fail closed: if the check itself throws, refuse the request rather
        // than letting an unverified host through on an error path.
        let why;
        try { why = await hostCheck(host); } catch (err) { why = `host check failed: ${err.message}`; }
        if (why) {
          onBlocked(req.url(), req.method(), why);
          req.abort('blockedbyclient').catch(() => {});
          return;
        }
      }
    }
    req.continue().catch(() => {});
  });
}

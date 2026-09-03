// Per-IP fixed-window request counter. Good enough for a public funnel meant
// to stop casual abuse and protect the VPS's own resources (each scan is a
// real headless Chrome) — not a hardened DDoS defense, which would need a
// front door (Cloudflare, a real reverse-proxy limiter) this tool has no
// business reimplementing.
export function createIpLimiter({ max = 3, windowMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map(); // ip -> { count, windowStart }

  function check(ip) {
    const t = now();
    const entry = hits.get(ip);
    if (!entry || t - entry.windowStart >= windowMs) {
      hits.set(ip, { count: 1, windowStart: t });
      return { allowed: true, remaining: max - 1 };
    }
    if (entry.count >= max) {
      return { allowed: false, remaining: 0, retryAfterMs: windowMs - (t - entry.windowStart) };
    }
    entry.count++;
    return { allowed: true, remaining: max - entry.count };
  }

  /** Call periodically so the map doesn't grow forever from one-off visitors. */
  function sweep() {
    const t = now();
    for (const [ip, entry] of hits) if (t - entry.windowStart >= windowMs) hits.delete(ip);
  }

  return { check, sweep, size: () => hits.size };
}

/** Bounds how many scans run at once, regardless of which IPs they come from —
 *  each one is a real browser, and the VPS has finite memory. */
export function createConcurrencyGate(max = 2) {
  let active = 0;
  return {
    tryAcquire: () => (active < max ? (active++, true) : false),
    release: () => { active = Math.max(0, active - 1); },
    active: () => active,
  };
}

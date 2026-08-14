// robots.txt + sitemap. Plain fetch, not the browser — robots/sitemaps are
// public on every real target. ponytail: an app that gates robots.txt behind
// auth returns 401 and we fail open (allow all), same as any crawler.

const GROUP_START = /^user-agent:\s*(.+)$/i;
const RULE = /^(allow|disallow):\s*(.*)$/i;

/** Parse robots.txt into { rules: [{allow, path}], sitemaps: [] } for one UA. */
export function parseRobots(text, ua = '*') {
  const sitemaps = [];
  const groups = new Map(); // ua -> rules
  let current = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sm = line.match(/^sitemap:\s*(.+)$/i);
    if (sm) { sitemaps.push(sm[1].trim()); continue; }
    const g = line.match(GROUP_START);
    if (g) {
      const agent = g[1].trim().toLowerCase();
      if (!groups.has(agent)) groups.set(agent, []);
      current = groups.get(agent);
      continue;
    }
    const r = line.match(RULE);
    if (r && current) current.push({ allow: r[1].toLowerCase() === 'allow', path: r[2].trim() });
  }
  // Most specific matching group wins: exact UA over '*'.
  return { rules: groups.get(ua.toLowerCase()) ?? groups.get('*') ?? [], sitemaps };
}

/** Longest-match wins; Allow breaks ties. Empty Disallow means "allow all". */
export function robotsAllows(rules, url) {
  let best = null;
  const u = new URL(url);
  const path = u.pathname + u.search;
  for (const rule of rules) {
    if (rule.path === '') continue; // "Disallow:" with no value = no restriction
    const pattern = rule.path.replace(/\*/g, '\u0000STAR\u0000');
    const matched = pattern.endsWith('$')
      ? new RegExp('^' + escape(pattern.slice(0, -1)) + '$').test(path)
      : new RegExp('^' + escape(pattern)).test(path);
    if (!matched) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

const escape = (s) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\u0000STAR\u0000', '.*');

async function get(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' }).catch(() => null);
  return res?.ok ? res.text() : null;
}

/** @returns {{allows: (url:string)=>boolean, sitemaps: string[]}} */
export async function loadRobots(originUrl, ua = '*') {
  const origin = new URL(originUrl).origin;
  const text = await get(`${origin}/robots.txt`);
  if (!text) return { allows: () => true, sitemaps: [] };
  const { rules, sitemaps } = parseRobots(text, ua);
  return { allows: (url) => robotsAllows(rules, url), sitemaps };
}

/** Pull <loc> URLs, following one level of <sitemapindex>. */
export async function loadSitemapUrls(originUrl, extraSitemaps = [], maxUrls = 5000) {
  const origin = new URL(originUrl).origin;
  const queue = [...new Set([...extraSitemaps, `${origin}/sitemap.xml`])];
  const urls = [];
  let followedIndexes = 0;

  while (queue.length && urls.length < maxUrls) {
    const xml = await get(queue.shift());
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex/i.test(xml)) {
      if (followedIndexes++ < 5) queue.push(...locs.slice(0, 50));
      continue;
    }
    urls.push(...locs);
  }
  return [...new Set(urls)].slice(0, maxUrls);
}

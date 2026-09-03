import { setTimeout as sleep } from 'node:timers/promises';
import { withTimeout } from '../timeout.js';
import { inCrawlScope, canonical } from './guard.js';
import { loadRobots, loadSitemapUrls } from './robots.js';
import { looksSignedOut, looksBlocked, MARK } from './session.js';

/**
 * BFS from the seed across N guarded tabs. `onPage(page, info)` is where the
 * scanner hooks in while the page is still loaded — do the work there, not on
 * a second visit.
 * @param {{page: import('puppeteer').Page, newPage: () => Promise<any>}} ctx from openSession()
 */
export async function crawl(ctx, client, onPage = async () => {}, { onSessionExpired = null, onAbandoned = null } = {}) {
  const cfg = client.crawl;
  const seed = canonical(client.seedUrl);
  const queue = [{ url: seed, depth: 0 }];
  const seen = new Set([seed]);
  const visited = [];
  let claimed = 1;
  let active = 0;
  let relogins = 0;
  const maxRelogins = cfg.maxReloginAttempts ?? 2;
  let abandoned = false;

  const robots = cfg.respectRobots === false
    ? { allows: () => true, sitemaps: [] }
    : await loadRobots(seed, cfg.userAgent ?? '*');

  if (cfg.seedFromSitemap) {
    const urls = await loadSitemapUrls(seed, robots.sitemaps);
    let added = 0;
    for (const raw of urls) {
      const url = canonical(raw);
      if (!url || seen.has(url) || inCrawlScope(url, seed, cfg) || !robots.allows(url)) continue;
      seen.add(url);
      queue.push({ url, depth: 0 });
      added++;
    }
    console.log(`sitemap: ${urls.length} urls found, ${added} in scope`);
  }

  const enqueue = (raw, depth) => {
    const url = canonical(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (inCrawlScope(url, seed, cfg)) return;
    if (!robots.allows(url)) return;
    queue.push({ url, depth });
  };

  async function worker(page) {
    for (;;) {
      const job = queue.shift();
      if (!job) {
        if (active === 0) return;
        await sleep(50);
        continue;
      }
      if (claimed > cfg.maxPages) return;
      claimed++;
      active++;
      try {
        let status = null;
        try {
          status = (await page.goto(job.url, { waitUntil: 'domcontentloaded' }))?.status() ?? null;
        } catch (err) {
          visited.push({ url: job.url, depth: job.depth, error: err.message });
          console.log(`  ✗ d${job.depth} ${job.url} — ${err.message}`);
          continue;
        }
        await sleep(cfg.settleMs);

        // Bot protection? Stop the whole site. Scanning the block page would
        // produce a report about Cloudflare's markup, labelled as the client's.
        const blocked = await looksBlocked(page, status);
        if (blocked) {
          abandoned = true;
          MARK.blocked(page.url(), blocked);
          visited.push({ url: job.url, depth: job.depth, error: `blocked: ${blocked}` });
          console.log(`  ✗ blocked at ${page.url()} — ${blocked}`);
          console.log('  nothing was scanned: a block page is not the site. Re-run with a real');
          console.log('  browser window (ui.headlessJobs: false) where you are an ordinary visitor.');
          // Console output does not survive past the job's lifetime — this is
          // the only copy of "why" that a report or `runs` listing can show
          // without the operator having kept the terminal scrollback.
          onAbandoned?.(`blocked at ${page.url()}: ${blocked}`);
          return;
        }

        // Session died mid-crawl? Stall rather than scanning a login wall and
        // reporting its accessibility as if it were the client's app.
        if (onSessionExpired && (await looksSignedOut(page, client))) {
          // Ask, but never nag: if signing in does not clear the signed-out
          // check twice running, the pattern or the credentials are wrong and
          // more prompts will not fix either.
          if (relogins >= maxRelogins) {
            abandoned = true;
            visited.push({ url: job.url, depth: job.depth, error: 'abandoned: still signed out after re-login' });
            console.log(`  ✗ giving up after ${relogins} sign-in attempts — check loggedOutPattern for "${client.id}"`);
            onAbandoned?.(`gave up after ${relogins} sign-in attempts — check loggedOutPattern for "${client.id}"`);
            return;
          }
          relogins++;
          console.log(`  ⏸ session expired at ${page.url()} — waiting for a human (attempt ${relogins}/${maxRelogins})`);
          await onSessionExpired(page.url());
          status = (await page.goto(job.url, { waitUntil: 'domcontentloaded' }))?.status() ?? null;
          await sleep(cfg.settleMs);
          if (await looksSignedOut(page, client)) {
            visited.push({ url: job.url, depth: job.depth, error: 'still signed out after login' });
            continue;
          }
          relogins = 0; // a successful sign-in resets the budget
        }

        const info = { url: job.url, finalUrl: page.url(), depth: job.depth, status, title: await page.title() };
        visited.push(info);
        console.log(`  ✓ d${job.depth} [${status}] ${info.finalUrl}`);
        // One page that never finishes must not wedge the whole audit. Lighthouse
        // and axe have no internal timeout, so the budget lives here.
        try {
          await withTimeout(onPage(page, info), cfg.pageTimeoutMs ?? 120000, `scanning ${info.finalUrl}`);
        } catch (err) {
          info.error = err.message;
          console.log(`  ⏱ ${err.message} — moving on`);
        }

        if (job.depth < cfg.maxDepth) {
          for (const href of await page.$$eval('a[href]', (as) => as.map((a) => a.href))) {
            enqueue(href, job.depth + 1);
          }
        }
      } finally {
        active--;
      }
    }
  }

  const workers = [ctx.page];
  for (let i = 1; i < (cfg.concurrency ?? 1); i++) workers.push(await ctx.newPage());
  await Promise.all(workers.map(worker));
  for (const page of workers.slice(1)) await page.close().catch(() => {});
  if (abandoned) console.log('[stage] crawl abandoned — the session could not be established');
  return visited.slice(0, cfg.maxPages);
}

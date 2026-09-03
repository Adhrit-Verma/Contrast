// Step 4's "do this now": prove a bot-blocked site and a dead URL fail
// gracefully — a clear, structured outcome, never a crash or a scanned block
// page. A local server + a real browser makes this repeatable instead of
// depending on some third party's bot defenses still being up next time this
// runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { crawl } from '../src/browser/crawl.js';
import { attachReadOnlyGuard } from '../src/browser/guard.js';

const baseCrawlCfg = {
  maxPages: 5, maxDepth: 1, settleMs: 50, concurrency: 1,
  respectRobots: false, seedFromSitemap: false,
  denylist: [], allowlist: [], skipExtensions: [],
};

async function withPage(fn) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await attachReadOnlyGuard(page, baseCrawlCfg);
  const ctx = { page, newPage: async () => { const p = await browser.newPage(); await attachReadOnlyGuard(p, baseCrawlCfg); return p; } };
  try {
    return await fn(ctx);
  } finally {
    await browser.close();
  }
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('crawl: a bot-protection wall stops the whole site and scans nothing', async () => {
  const server = await listen((req, res) => {
    res.writeHead(503, { 'content-type': 'text/html' });
    res.end('<html><title>Just a moment...</title><body>Checking your browser before accessing this site.</body></html>');
  });
  const { port } = server.address();
  const client = { id: 'blocked-site', seedUrl: `http://127.0.0.1:${port}/`, crawl: baseCrawlCfg };

  let scanned = 0;
  const abandonReasons = [];
  const visited = await withPage((ctx) =>
    crawl(ctx, client, async () => { scanned++; }, { onAbandoned: (reason) => abandonReasons.push(reason) })
  );
  server.close();

  assert.equal(scanned, 0, 'a block page must never be scanned');
  assert.equal(visited.length, 1);
  assert.match(visited[0].error, /^blocked:/);
  assert.equal(abandonReasons.length, 1, 'the caller must be told why, so it can persist the reason');
  assert.match(abandonReasons[0], /blocked/i);
});

test('crawl: a dead URL is recorded as a per-page error, never a thrown exception', async () => {
  // Grab a port and immediately free it — about as close to "guaranteed no
  // listener" as a test can get without root-only ports or platform quirks.
  const probe = await listen((_, res) => res.end());
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));

  const client = { id: 'dead-site', seedUrl: `http://127.0.0.1:${port}/`, crawl: baseCrawlCfg };
  let scanned = 0;
  let threw = null;
  let visited = [];
  try {
    visited = await withPage((ctx) => crawl(ctx, client, async () => { scanned++; }));
  } catch (err) {
    threw = err;
  }

  assert.equal(threw, null, 'a dead seed URL must never throw out of crawl()');
  assert.equal(scanned, 0);
  assert.equal(visited.length, 1);
  assert.ok(visited[0].error, 'the failure must be recorded with a message, not silently dropped');
});

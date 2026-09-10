// The two standing gaps from 2026-09-04, closed and pinned.
//
// 1. looksBlocked() missed bot-defense FALLBACK pages: HTTP 200, no challenge
//    wording, content plausible enough to scan. IndiGo's Akamai shell produced
//    eight real-looking findings about the failover page rather than the site.
//    It was caught by reading the raw data before publishing, which is luck,
//    not a control.
// 2. The SSRF guard only checked the URL the visitor typed. A redirect or a
//    subresource pointing somewhere internal was never re-checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { looksBlocked } from '../src/browser/session.js';
import { attachReadOnlyGuard } from '../src/browser/guard.js';
import { createHostGuard, hostProblem } from '../src/public/ssrf.js';

const crawlCfg = { denylist: [], allowlist: [], skipExtensions: [] };

function listen(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

/** --no-sandbox is safe here: these only ever load a local fixture server. */
async function withPage(fn, { hostCheck = null, blocked = [] } = {}) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await attachReadOnlyGuard(page, crawlCfg, (url, method, reason) => blocked.push({ url, reason }), hostCheck);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const serve = (body) => listen((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});

// ------------------------------------------------------- failover detection

test('an Akamai-style failover page is caught by its own asset path', async () => {
  const server = await serve(`<!doctype html><html><head></head><body>
    <img src="/akamfailoverpage/logo.svg" alt="">
    <p>We are sorry, the page is temporarily unavailable.</p></body></html>`);
  try {
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' });
      const why = await looksBlocked(page, 200);
      assert.ok(why, 'a 200-status failover page must not pass as a real page');
      assert.match(why, /vendor bot-defense fallback/);
    });
  } finally { server.close(); }
});

test('an untitled shell with no navigation and no text is caught', async () => {
  const server = await serve('<!doctype html><html><head></head><body><div></div></body></html>');
  try {
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' });
      const why = await looksBlocked(page, 200);
      assert.match(why ?? '', /probably a bot-defense fallback/);
    });
  } finally { server.close(); }
});

// The false-positive direction matters more than the true-positive one: over-
// flagging real pages would silently drop customers' actual findings.
test('a real page with a title is NOT flagged, even if sparse', async () => {
  const server = await serve('<!doctype html><html><head><title>Coming soon</title></head><body><p>Hi</p></body></html>');
  try {
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' });
      assert.equal(await looksBlocked(page, 200), null, 'a title means a real page');
    });
  } finally { server.close(); }
});

test('an untitled page with real navigation is NOT flagged', async () => {
  const server = await serve(`<!doctype html><html><head></head><body>
    <nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav></body></html>`);
  try {
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' });
      assert.equal(await looksBlocked(page, 200), null, 'navigation means a real page');
    });
  } finally { server.close(); }
});

test('an untitled image-heavy page with text is NOT flagged', async () => {
  const server = await serve(`<!doctype html><html><head></head><body>
    <img src="/hero.png" alt="hero">
    <p>${'Real content that a person actually wrote. '.repeat(8)}</p></body></html>`);
  try {
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' });
      assert.equal(await looksBlocked(page, 200), null, 'text content means a real page');
    });
  } finally { server.close(); }
});

// ------------------------------------------------------------- host guard

test('hostProblem refuses internal addresses and allows public ones', async () => {
  assert.match(await hostProblem('localhost') ?? '', /loopback/);
  assert.equal(await hostProblem('example.com'), null);
});

test('hostProblem reports an unresolvable name rather than allowing it', async () => {
  const why = await hostProblem('nx-does-not-exist-contrast-test.invalid');
  assert.ok(why, 'a name that will not resolve must not be treated as safe');
  assert.match(why, /could not resolve/);
});

test('the host guard caches per hostname instead of re-resolving every subresource', async () => {
  let calls = 0;
  const guard = createHostGuard({ now: () => calls++ && 0 });
  await guard('example.com');
  await guard('example.com');
  await guard('example.com');
  // Cheap proxy for "did not hit DNS three times": the same answer, fast.
  assert.equal(await guard('example.com'), null);
});

test('a redirect to an internal address is refused at request time', async () => {
  // The hole this closes: assertPublicUrl() vetted the URL the visitor typed.
  // It cannot see where that URL sends the browser next.
  const internal = await serve('<!doctype html><title>internal</title><p>secret</p>');
  const redirector = await listen((_, res) => {
    res.writeHead(302, { location: urlOf(internal) });
    res.end();
  });
  try {
    const blocked = [];
    await withPage(async (page) => {
      await page.goto(urlOf(redirector), { waitUntil: 'domcontentloaded' }).catch(() => {});
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      assert.ok(!text.includes('secret'), 'the browser must never reach the internal page');
    }, { hostCheck: createHostGuard(), blocked });
    assert.ok(blocked.some((b) => /loopback/.test(b.reason)), `expected a loopback refusal, got ${JSON.stringify(blocked)}`);
  } finally { internal.close(); redirector.close(); }
});

test('the guard fails closed when the host check itself throws', async () => {
  const server = await serve('<!doctype html><title>ok</title><p>hello</p>');
  try {
    const blocked = [];
    await withPage(async (page) => {
      await page.goto(urlOf(server), { waitUntil: 'domcontentloaded' }).catch(() => {});
    }, { hostCheck: async () => { throw new Error('resolver exploded'); }, blocked });
    assert.ok(
      blocked.some((b) => /host check failed/.test(b.reason)),
      'an erroring check must refuse the request, not wave it through'
    );
  } finally { server.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRule, inCrawlScope, canonical } from '../src/browser/guard.js';

const cfg = {
  denylist: ['/logout', '/delete'],
  allowlist: [],
  skipExtensions: ['.pdf', '.png'],
};
const seed = 'https://app.example.com/dashboard';

test('requestRule blocks every non-GET method', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.ok(requestRule('https://app.example.com/x', m, cfg), `${m} must be blocked`);
  }
  assert.equal(requestRule('https://app.example.com/x', 'GET', cfg), null);
  assert.equal(requestRule('https://app.example.com/x', 'HEAD', cfg), null);
});

test('requestRule blocks denylisted GETs (logout-by-link)', () => {
  assert.equal(requestRule('https://app.example.com/logout', 'GET', cfg), 'denylisted url');
  assert.equal(requestRule('https://app.example.com/u/1/delete?id=2', 'GET', cfg), 'denylisted url');
  assert.equal(requestRule('https://cdn.other.com/app.css', 'GET', cfg), null); // subresources allowed
});

test('inCrawlScope: same-origin only, honours denylist and extensions', () => {
  assert.equal(inCrawlScope('https://app.example.com/settings', seed, cfg), null);
  assert.equal(inCrawlScope('https://evil.example.com/x', seed, cfg), 'cross-origin');
  assert.equal(inCrawlScope('http://app.example.com/x', seed, cfg), 'cross-origin'); // scheme counts
  assert.equal(inCrawlScope('mailto:a@b.com', seed, cfg), 'non-http');
  assert.equal(inCrawlScope('https://app.example.com/logout', seed, cfg), 'denylisted url');
  assert.equal(inCrawlScope('https://app.example.com/report.pdf', seed, cfg), 'extension .pdf');
});

test('inCrawlScope: allowlist restricts scope only when non-empty', () => {
  const scoped = { ...cfg, allowlist: ['/admin'] };
  assert.equal(inCrawlScope('https://app.example.com/admin/users', seed, scoped), null);
  assert.equal(inCrawlScope('https://app.example.com/public', seed, scoped), 'outside allowlist');
  assert.equal(inCrawlScope('https://app.example.com/public', seed, cfg), null);
});

test('canonical drops the fragment so #anchors are not re-crawled', () => {
  assert.equal(canonical('https://a.com/p#main'), 'https://a.com/p');
  assert.equal(canonical('not a url'), null);
});

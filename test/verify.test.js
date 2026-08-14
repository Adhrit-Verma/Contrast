// Real browser, real axe. Slower than the rest of the suite, but a fix that is
// not verified is only a suggestion — this is the check that earns the label.
import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { verifyFix } from '../src/verify/index.js';
import { attachReadOnlyGuard } from '../src/browser/guard.js';

const PAGE = `<!doctype html><html lang="en"><head><title>Fixture</title></head>
<body><main><h1>Fixture</h1>
<img id="hero" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
<p>Body copy.</p></main></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'a11y-verify-'));
const file = join(dir, 'fixture.html');
writeFileSync(file, PAGE);
const pageUrl = pathToFileURL(file).href;

const finding = {
  id: 'f1',
  pageUrl,
  ruleId: 'image-alt',
  domSelector: 'img#hero',
  htmlSnippet: '<img id="hero" src="…">',
  source: 'axe',
  raw: { target: ['img#hero'] },
};

async function withBrowser(fn) {
  const browser = await puppeteer.launch({ headless: true });
  const ctx = {
    browser,
    newPage: async () => {
      const p = await browser.newPage();
      await attachReadOnlyGuard(p, { denylist: [] });
      return p;
    },
  };
  try {
    return await fn(ctx);
  } finally {
    await browser.close();
  }
}

test('verifyFix: a real fix is verified', async () => {
  const result = await withBrowser((ctx) =>
    verifyFix(ctx, { selector: 'img#hero', after: '<img id="hero" src="x.gif" alt="Acme company logo">', finding })
  );
  assert.equal(result.status, 'verified', result.notes);
});

test('verifyFix: a fix that does not resolve the violation is unresolved, not verified', async () => {
  const result = await withBrowser((ctx) =>
    // Cosmetic change only — still no accessible name, so axe still fires.
    verifyFix(ctx, { selector: 'img#hero', after: '<img id="hero" src="x.gif" class="logo" data-fixed="true">', finding })
  );
  assert.equal(result.status, 'unresolved', result.notes);
});

test('verifyFix: a fix that introduces a new violation is regressed', async () => {
  const result = await withBrowser((ctx) =>
    verifyFix(ctx, {
      selector: 'img#hero',
      after: '<img id="hero" src="x.gif" alt="Acme logo"><a id="ghost" href="#"></a>',
      finding,
    })
  );
  assert.equal(result.status, 'regressed', result.notes);
  assert.ok(result.regressions.some((r) => r.startsWith('link-name')), result.notes);
});

test('verifyFix: an AI judgment call is reported unverified, never verified by axe', async () => {
  const aiFinding = { ...finding, source: 'ai', ruleId: 'ai-alt-text-quality' };
  const result = await withBrowser((ctx) =>
    verifyFix(ctx, { selector: 'img#hero', after: '<img id="hero" src="x.gif" alt="Acme company logo">', finding: aiFinding })
  );
  assert.equal(result.status, 'unverified');
  assert.match(result.notes, /auditor review/i);
});

test('verifyFix: a selector that no longer exists is an error, never a pass', async () => {
  const result = await withBrowser((ctx) =>
    verifyFix(ctx, { selector: 'img#missing', after: '<img alt="x">', finding })
  );
  assert.equal(result.status, 'error');
});

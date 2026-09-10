// The report builders had no test file at all — `CLAUDE.md` has named that as
// a known gap since 2026-09-04. This does not try to close it; it pins the two
// things that were actually got wrong on 2026-09-10, both of which are silent
// failures that only show up in front of a reader:
//
//   1. a free scan's report headlining "contrast-public" instead of the site
//   2. our own org mark appearing on a report an auditor hands to their client
//
// Neither would fail a build. Both would embarrass someone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, insert, insertFindings } from '../src/db.js';
import { writeHtml, siteNameOf } from '../src/report/index.js';
import { runDir } from '../src/scan/index.js';

test('siteNameOf names the scanned site, never the internal client handle', () => {
  // The bug: a free scan is stored under clientId "contrast-public", so every
  // public report used to be titled after our own service.
  assert.equal(
    siteNameOf({ seedUrl: 'https://www.example.com/a/b?c=1', clientId: 'contrast-public' }),
    'example.com'
  );
  assert.equal(siteNameOf({ seedUrl: 'https://sub.example.co.uk/', clientId: 'x' }), 'sub.example.co.uk');
});

test('siteNameOf degrades to something readable rather than throwing', () => {
  // A seedUrl that will not parse must not take the whole report down.
  assert.equal(siteNameOf({ seedUrl: 'not a url', clientId: 'acme' }), 'not a url');
  assert.equal(siteNameOf({ clientId: 'acme' }), 'acme');
  assert.equal(siteNameOf({}), 'this site');
});

/** A minimal run with one finding, enough for writeHtml to render. */
function seed(db, runId) {
  insert(db, 'runs', {
    id: runId, clientId: 'contrast-public', seedUrl: 'https://example.com/',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  });
  insert(db, 'pages', { runId, url: 'https://example.com/', finalUrl: 'https://example.com/', title: 'Example', status: 200 });
  insertFindings(db, [{
    id: `${runId}-f1`, runId, fingerprint: 'fp1', pageUrl: 'https://example.com/',
    timestamp: new Date().toISOString(), source: 'axe', wcagCriterion: '1.1.1', wcagLevel: 'A',
    severity: 'critical', ruleId: 'image-alt', domSelector: 'img', htmlSnippet: '<img>',
    description: 'Images must have alternative text', confidence: 1,
  }]);
}

function render(runId, opts) {
  const dbPath = `runs/__test-report-${runId}.sqlite`;
  const db = openDb(dbPath);
  seed(db, runId);
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'report.html');
  try {
    writeHtml(db, runId, out, [], opts);
    return readFileSync(out, 'utf8');
  } finally {
    db.close(); // Windows holds the file open otherwise
    rmSync(dir, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
}

test('the report is titled after the site, not the client handle', () => {
  const html = render(`t-${randomUUID()}`, {});
  assert.match(html, /<title>Accessibility audit — example\.com<\/title>/);
  assert.match(html, /<h1>example\.com<\/h1>/);
  assert.doesNotMatch(html, /contrast-public/);
});

test('an admin report carries no support ask, no placeholders and no org mark', () => {
  // This is a deliverable an auditor hands to their own client. Everything
  // that belongs to *our* funnel has to be absent from it.
  const html = render(`t-${randomUUID()}`, {});
  // Markup markers, not words: "coming soon" also appears in a CSS comment
  // that ships on every report, and asserting on prose would fail on that.
  for (const marker of ['Vimoksh', '<div class="ghosts"', 'id="support"', 'id="deeper"']) {
    assert.ok(!html.includes(marker), `admin report must not contain ${marker}`);
  }
});

test('a public-funnel report does carry them — the gate opens, it is not stuck shut', () => {
  const html = render(`t-${randomUUID()}`, { supportUrl: 'https://example.org/give', comingSoon: true });
  assert.ok(html.includes('Vimoksh'), 'public report should carry the org mark');
  assert.ok(html.includes('id="support"'), 'public report should carry the support ask');
});

test('findings are grouped by issue, and sharing is reachable without copying a URL', () => {
  const html = render(`t-${randomUUID()}`, {});
  assert.match(html, /<details class="issue"/, 'findings render as issue cards');
  assert.match(html, /id="share-btn"/, 'the share button exists');
  assert.match(html, /id="print-btn"/, 'the save-as-PDF button exists');
  assert.match(html, /href="report\.json" download/, 'the JSON download exists');
});

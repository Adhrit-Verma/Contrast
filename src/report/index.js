// Phase 6. Plain string templating — a report viewer is not a product UI.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import axeCore from 'axe-core';
import { getFindings, getRun, getPages, getFixes, getReviewQueue } from '../db.js';
import { wcagFromTags } from '../scan/normalize.js';

export const LIMITS_NOTICE =
  'Automated testing detects roughly 30–40% of WCAG issues. This report is NOT a claim of ' +
  'conformance. Findings marked AI-assessed are judgments, not measurements, and every one ' +
  'needs auditor confirmation. Absence of findings is not evidence of accessibility.';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEV_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];
const understanding = (c) => (c ? `https://www.w3.org/WAI/WCAG22/Understanding/${c}` : null);

// ------------------------------------------------------------- coverage

// Criteria our own non-axe detectors cover: the keyboard and a11y-tree rules in
// scan/normalize.js, and the five AI judgment tasks in ai/tasks.js. Listed here
// rather than imported because importing ai/tasks.js drags Lighthouse and
// Puppeteer into every report render; test/coverage.test.js asserts it stays in
// step with TASKS so the list cannot silently drift.
const OWN_CRITERIA = ['1.1.1', '1.3.1', '1.3.2', '2.4.3', '2.4.4', '2.4.7', '3.3.2', '4.1.2'];

// axe ships rules it does not actually run: experimental and deprecated ones,
// plus AAA rules that are off unless explicitly enabled. Counting those as
// coverage claims checks that never happen — the ACT harness caught exactly
// that (1.4.6, 2.5.3, 1.3.4 each had a "rule" that detected nothing at all).
const NOT_RUN_BY_DEFAULT = ['experimental', 'deprecated', 'wcag2aaa'];

/**
 * Every criterion with an automated rule that actually runs. Derived from axe's
 * own rule metadata, never a hand-maintained table — as normalize.js does.
 */
export function automatedCriteria() {
  const out = new Set(OWN_CRITERIA);
  for (const rule of axeCore.getRules()) {
    const tags = rule.tags ?? [];
    if (NOT_RUN_BY_DEFAULT.some((t) => tags.includes(t))) continue;
    const { criterion } = wcagFromTags(tags);
    if (criterion) out.add(criterion);
  }
  return out;
}

export const COVERAGE_NOTE =
  'A criterion counted as automated only means a rule exists that can test it. It is not a claim ' +
  'that this run proved anything: a criterion with no findings still needs a human to confirm it, ' +
  'and criteria marked manual-only cannot be tested by any automated rule at all.';

/**
 * Per-criterion coverage for the catalogue: which criteria a machine could even
 * look at, and which are human-only work. This is what stops a report with few
 * findings from reading as a clean bill of health.
 */
export function wcagCoverage(findings, catalogue = []) {
  const auto = automatedCriteria();
  const counts = new Map();
  for (const f of findings) {
    if (f.wcagCriterion) counts.set(f.wcagCriterion, (counts.get(f.wcagCriterion) ?? 0) + 1);
  }
  const rows = catalogue.map((c) => {
    const hits = counts.get(c.number) ?? 0;
    const automated = auto.has(c.number);
    return {
      ...c,
      automated,
      findings: hits,
      status: !automated ? 'manual-only' : hits ? 'findings' : 'checked-clean',
    };
  });
  return {
    note: COVERAGE_NOTE,
    rows,
    counts: {
      total: rows.length,
      automated: rows.filter((r) => r.automated).length,
      manualOnly: rows.filter((r) => !r.automated).length,
      withFindings: rows.filter((r) => r.status === 'findings').length,
      checkedClean: rows.filter((r) => r.status === 'checked-clean').length,
    },
  };
}

export function buildReport(db, runId, catalogue = []) {
  const run = getRun(db, runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const findings = getFindings(db, runId);
  const fixes = getFixes(db, runId);
  const fixByFinding = new Map(fixes.map((f) => [f.findingId, f]));

  return {
    run: { ...run, config: run.config ? JSON.parse(run.config) : null },
    generatedAt: new Date().toISOString(),
    limits: LIMITS_NOTICE,
    summary: summarise(findings, fixes),
    coverage: wcagCoverage(findings, catalogue),
    pages: getPages(db, runId),
    findings: findings.map((f) => ({ ...f, fix: fixByFinding.get(f.id) ?? null })),
    reviewQueue: getReviewQueue(db, runId),
  };
}

function summarise(findings, fixes) {
  const count = (arr, key) =>
    arr.reduce((acc, f) => ((acc[f[key] ?? 'unknown'] = (acc[f[key] ?? 'unknown'] ?? 0) + 1), acc), {});
  return {
    findings: findings.length,
    deterministic: findings.filter((f) => f.source !== 'ai').length,
    aiAssessed: findings.filter((f) => f.source === 'ai').length,
    needsReview: findings.filter((f) => f.confidence < 1).length,
    bySeverity: count(findings, 'severity'),
    bySource: count(findings, 'source'),
    byLevel: count(findings, 'wcagLevel'),
    byCriterion: count(findings, 'wcagCriterion'),
    pages: new Set(findings.map((f) => f.pageUrl)).size,
    fixes: {
      total: fixes.length,
      verified: fixes.filter((f) => f.verification === 'verified').length,
      unverified: fixes.filter((f) => f.verification !== 'verified' && f.verification !== 'regressed').length,
      regressed: fixes.filter((f) => f.verification === 'regressed').length,
    },
  };
}

export function writeJson(db, runId, path, catalogue = []) {
  const report = buildReport(db, runId, catalogue);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

// ------------------------------------------------------------------ HTML

// Same brand tokens as the public site (src/public/public/*.html) and the
// audit writeups (src/public/server.js's AUDIT_PAGE_STYLE) — one visual
// language across every surface, not a fourth look-and-feel for the one
// document people actually forward to a client.
export const CSS = `
:root {
  --canvas:#faf9f5; --surface:#fff; --surface-2:#f5f0e8; --line:#e6dfd8; --line-strong:#d5cec2;
  --text:#141413; --text-2:#3d3d3a; --text-3:#6c6a64; --accent:#cc785c; --accent-text:#a25439; --accent-soft:#f7ece6;
  --ok:#2a7346; --ok-soft:#e6f2ea;
  --det:#3d3d3a; --ai:var(--accent);
  --sev-critical-bg:#fdecea; --sev-critical-fg:#9b1c14; --sev-serious-bg:#fbeee0; --sev-serious-fg:#8a4200;
  --sev-moderate-bg:#f8f1d8; --sev-moderate-fg:#6b5300; --sev-minor-bg:#f0efec; --sev-minor-fg:#4a4a4a;
  --font-display:"Tiempos Headline","Iowan Old Style",Georgia,serif;
  --font-ui:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:ui-monospace,"JetBrains Mono",Consolas,monospace;
  --ease: cubic-bezier(.2,.8,.2,1);
}
* { box-sizing:border-box }
html { scroll-behavior:smooth }
body { font:16px/1.6 var(--font-ui); margin:0; color:var(--text); background:var(--canvas) }
a { color:var(--accent-text) }
/* CSS selectors and URLs have no spaces to break on — without this they push
   the whole document sideways on a phone. */
code { font-family:var(--font-mono); font-size:.9em; overflow-wrap:anywhere }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px }

/* --------------------------------------------------------------- hero
   Full-bleed dark cover, like a real audit's title page, before settling
   into the light body — the report's own "measured vs assessed" story
   starts the instant you land on it, not three scrolls in. */
.hero { background:var(--text); color:var(--canvas); padding:56px 40px 64px }
.hero-inner { max-width:1440px; margin:0 auto }
/* Brand left, actions right — the two things a reader does with a report they
   were sent are share it onward and keep a copy, so both sit above the fold
   rather than buried at the end. */
.brand-row { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:36px }
.brand-row .by { font-size:13px; color:#8d8a83; letter-spacing:.02em }
.hero-actions { margin-left:auto; display:flex; gap:10px; flex-wrap:wrap }
.act {
  display:inline-flex; align-items:center; gap:8px; font:inherit; font-size:13.5px; font-weight:600;
  color:var(--canvas); background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.18);
  border-radius:4px; padding:9px 15px; cursor:pointer; text-decoration:none;
  transition:background .15s var(--ease), border-color .15s var(--ease), transform .15s var(--ease);
}
.act:hover { background:var(--canvas); border-color:var(--canvas); color:var(--text) }
.act:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
.act-primary { background:var(--accent); border-color:var(--accent); color:#141413 }
.act-primary:hover { background:#dd8a6d; border-color:#dd8a6d }
.act svg { flex:none }
.share-note { font-size:13px; color:#7fcf9d; margin:0 0 22px }
.hero .brand { display:flex; align-items:center; gap:9px; font-family:var(--font-display); font-size:17px; opacity:.9 }
.hero .brand .mark { width:24px; height:24px; border-radius:4px; background:var(--accent); display:grid; place-items:center; flex:none }
.hero .brand .mark { --c:56.55; color:var(--canvas); padding:4px }
.hero .brand .mark svg { width:100%; height:100%; display:block; transform:rotate(47deg) }
.hero .brand .mark circle { fill:none; stroke-width:3.5; stroke-linecap:round }
.hero .brand .mark .track { stroke:currentColor; opacity:.22 }
.hero .brand .mark .arc { stroke:currentColor; stroke-dasharray:var(--c); stroke-dashoffset:calc(var(--c)*.26) }
.hero .brand .mark[data-state="running"] svg { animation:c-spin 1.6s linear infinite }
.hero .brand .mark[data-state="running"] .arc { animation:c-chase 1.6s var(--ease) infinite }
@keyframes c-spin { from { rotate:0deg } to { rotate:360deg } }
@keyframes c-chase { 0% { stroke-dashoffset:calc(var(--c)*.92) } 50% { stroke-dashoffset:calc(var(--c)*.22) } 100% { stroke-dashoffset:calc(var(--c)*.92) } }
@media (prefers-reduced-motion:reduce) { .hero .brand .mark[data-state="running"] svg, .hero .brand .mark[data-state="running"] .arc { animation:none } .hero .brand .mark[data-state="running"] .arc { stroke-dashoffset:calc(var(--c)*.5) } }
.eyebrow { font-family:var(--font-mono); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#e0a794; margin:0 0 10px }
.hero h1 { font-family:var(--font-display); font-weight:400; font-size:clamp(32px,5vw,54px); line-height:1.1; margin:0 0 10px; letter-spacing:-.01em }
.hero .seed { font-family:var(--font-mono); font-size:15px; margin:0 0 6px; word-break:break-all }
.hero .seed a { color:#e0a794; text-decoration:none; border-bottom:1px solid rgba(224,167,148,.4) }
.hero .seed a:hover { border-bottom-color:#e0a794 }
.hero .meta-line { font-size:13px; color:#a09d96; margin:0 0 40px }
.hero-abandoned { background:rgba(255,107,92,.12); border:1px solid rgba(255,107,92,.35); border-radius:4px; padding:14px 18px; margin:0 0 32px; font-size:14px; color:#ffd4cc }
.hero-abandoned b { color:#fff }
.hero-grid { display:grid; grid-template-columns:auto minmax(0,1fr); gap:64px; align-items:center }
@media (max-width:900px) { .hero-grid { grid-template-columns:1fr; gap:32px } }
.ring-wrap { display:flex; align-items:center; gap:24px; flex-wrap:wrap }
.ring-legend { display:grid; gap:8px; font-size:14px }
.ring-legend .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:9px }
.hero-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:24px; border-left:1px solid rgba(255,255,255,.14); padding-left:64px }
@media (max-width:900px) { .hero-stats { border-left:0; padding-left:0; grid-template-columns:repeat(2,1fr) } }
.hero-stat b { display:block; font-family:var(--font-mono); font-size:clamp(34px,4.4vw,56px); line-height:1; font-variant-numeric:tabular-nums; color:#fff; margin-bottom:6px }
.hero-stat span { font-size:13px; color:#a09d96; line-height:1.35; display:block }
.hero-stat.accent b { color:#e6a68e }
.hero-stat.ok b { color:#7fcf9d }

/* ------------------------------------------------------------ story nav */
.story-nav { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--canvas) 90%, transparent); backdrop-filter:blur(8px); border-bottom:1px solid var(--line) }
.story-nav-inner { max-width:1440px; margin:0 auto; padding:0 40px; display:flex; gap:4px; overflow-x:auto }
.story-nav a { display:block; padding:14px 14px; font-size:13.5px; font-weight:600; color:var(--text-3); text-decoration:none; white-space:nowrap; border-bottom:2px solid transparent }
.story-nav a:hover { color:var(--text) }

main { max-width:1440px; margin:0 auto; padding:0 40px 96px }
@media (max-width:560px) { main { padding:0 18px 72px } .hero { padding:40px 18px 48px } .story-nav-inner { padding:0 18px } }
section { padding:64px 0; border-bottom:1px solid var(--line) }
section:last-child { border-bottom:0 }
.section-head { max-width:760px; margin:0 0 32px }
.section-head .eyebrow { color:var(--accent-text) }
h2 { font-family:var(--font-display); font-weight:400; font-size:clamp(24px,2.6vw,32px); margin:0 0 10px; letter-spacing:-.01em }
.section-head p { color:var(--text-2); margin:0; font-size:15.5px; line-height:1.6 }

.notice { background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:0 10px 10px 0; padding:16px 20px; margin:0 0 20px; font-size:14.5px; color:var(--text-2) }
.notice b { color:var(--text) }

/* -------------------------------------------------------- measured/assessed
   The distinction gets shown, not just claimed — same pattern as the public
   landing page's own demo strip, so the story is visually consistent site-wide. */
.demo { background:var(--surface); border:1px solid var(--line); border-radius:4px; overflow:hidden; max-width:900px }
.demo-row { display:flex; gap:12px; align-items:flex-start; padding:16px 18px }
.demo-row + .demo-row { border-top:1px solid var(--line) }
.demo-row.det { border-left:3px solid var(--text-2) }
.demo-row.ai { border-left:4px dotted var(--accent) }
.dtag { flex:none; font-family:var(--font-mono); font-size:11px; font-weight:700; padding:4px 9px; border-radius:4px; letter-spacing:.02em }
.dtag.det { background:var(--surface-2); color:var(--text-2) }
.dtag.ai { background:var(--accent-soft); color:var(--accent-text) }
.demo-row p { margin:0; font-size:14px; color:var(--text-2) }

/* ------------------------------------------------------------ coverage */
.coverage-bar { height:18px; border-radius:999px; overflow:hidden; display:flex; background:var(--surface-2); margin:24px 0 14px }
.coverage-bar i { display:block; height:100% }
.coverage-key { display:flex; gap:20px; flex-wrap:wrap; font-size:13px; color:var(--text-2); margin-bottom:24px }
.coverage-key span { display:inline-flex; align-items:center; gap:6px }
.coverage-key .dot { width:9px; height:9px; border-radius:50% }

/* ----------------------------------------------------------- data table */
.table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:4px; background:var(--surface) }
table { border-collapse:collapse; width:100%; font-size:14px }
/* Wrap rather than force a scroll container: these cells are criterion names
   and reasons, not code — breaking them is kinder than a hidden sideways
   scrollbar, and it stops a closed <details> leaking into document width. */
th,td { padding:10px 14px; text-align:left; border-bottom:1px solid var(--line); overflow-wrap:anywhere }
th { background:var(--surface-2); font-weight:700; color:var(--text) }
tr:last-child td { border-bottom:0 }
details.coverage-detail { margin-top:8px }
details.coverage-detail summary { cursor:pointer; font-size:13.5px; font-weight:600; color:var(--accent-text); padding:6px 0 }

/* -------------------------------------------------------------- findings
   One card per distinct ISSUE, laid out across the width instead of down it.
   A 990-finding run is about twenty problems repeated across a template; the
   old page > component > finding accordion made the reader scroll a kilometre
   to learn that. Cards stay <details> so the report still works with CSS off.

   Masonry via CSS columns rather than grid: an open card grows tall, and a
   grid row would leave a gap the height of the tallest card beside it. */
.filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 18px }
.chip { font:600 13px/1 var(--font-ui); display:inline-flex; align-items:center; gap:7px; padding:8px 13px; border-radius:999px; border:1px solid var(--line-strong); background:var(--surface); color:var(--text-2); cursor:pointer; transition:background .15s, color .15s, border-color .15s; text-transform:capitalize }
.chip:hover { border-color:var(--text-3); color:var(--text) }
.chip:focus-visible { outline:2px solid var(--accent-text); outline-offset:2px }
.chip.on { background:var(--text); border-color:var(--text); color:var(--canvas) }
.chip-n { font-family:var(--font-mono); font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; background:var(--surface-2); color:var(--text-2) }
.chip.on .chip-n { background:rgba(255,255,255,.18); color:var(--canvas) }
.chip-ghost { margin-left:auto; background:transparent; border-style:dashed }
.filters-sep { width:1px; align-self:stretch; background:var(--line); margin:0 4px }

.issue-grid { columns:2 400px; column-gap:18px }
.issue { break-inside:avoid; display:inline-block; width:100%; margin:0 0 18px; background:var(--surface); border:1px solid var(--line); border-radius:4px; overflow:hidden }
.issue[hidden] { display:none }
.issue > summary { cursor:pointer; list-style:none; position:relative; padding:16px 18px 15px 22px; display:grid; gap:9px }
.issue > summary::-webkit-details-marker { display:none }
.issue > summary:focus-visible { outline:2px solid var(--accent-text); outline-offset:-3px; border-radius:4px }
.issue > summary:hover { background:var(--surface-2) }
/* The severity stripe: colour carries the same information the badge does in
   words, so it is never the only signal. */
.issue-bar { position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--text-3) }
.issue[data-sev=critical] .issue-bar { background:var(--sev-critical-fg) }
.issue[data-sev=serious] .issue-bar { background:var(--sev-serious-fg) }
.issue[data-sev=moderate] .issue-bar { background:var(--sev-moderate-fg) }
.issue[data-sev=minor] .issue-bar { background:var(--sev-minor-fg) }
.issue[data-src=ai] .issue-bar { background:repeating-linear-gradient(180deg,var(--accent) 0 6px,transparent 6px 11px) }
.issue-top { display:flex; flex-wrap:wrap; gap:6px; align-items:center }
.issue-title { font-family:var(--font-display); font-size:19px; line-height:1.28; font-weight:400; color:var(--text); overflow-wrap:anywhere }
.issue-foot { display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; font-size:12.5px; color:var(--text-2) }
.issue-count { font-family:var(--font-mono); font-size:15px; font-weight:700; color:var(--text) }
.issue-rule { font-family:var(--font-mono); font-size:11.5px; color:var(--text-3); margin-left:auto }
.issue-body { padding:2px 18px 16px 22px; border-top:1px solid var(--line) }
.issue-body .finding { border-radius:0 8px 8px 0; padding:13px 15px; margin:12px 0 0 }
/* A forty-line markup dump is not read, it is scrolled past. Clamp it and let
   anyone who wants the whole thing scroll inside the box. */
.issue-body pre { max-height:170px; overflow:auto; margin:8px 0 0 }
.issue-body .shot { max-height:200px; width:auto }
/* One column below the two-column threshold, and no reason to make a phone
   render a masonry it cannot use. */
@media (max-width:700px) {
  .issue-grid { columns:1 }
  .chip-ghost { margin-left:0 }
  /* One column means every collapsed card costs a full row of scroll, so the
     card gets tighter here rather than the list getting shorter. */
  .issue { margin-bottom:12px }
  .issue > summary { padding:13px 15px 12px 19px; gap:7px }
  .issue-title { font-size:17px }
  .issue-rule { margin-left:auto }
}

.finding { border-left:3px solid var(--text-3); background:var(--surface); border-radius:0 10px 10px 0; padding:16px 18px; margin:10px 0 }
.finding.ai { border-left-style:dotted; border-left-width:4px; border-left-color:var(--accent) }
.finding.sev-critical { border-left-color:var(--sev-critical-fg) }
.finding.sev-serious { border-left-color:var(--sev-serious-fg) }
.finding.sev-moderate { border-left-color:var(--sev-moderate-fg) }
.finding.sev-minor { border-left-color:var(--sev-minor-fg) }
.finding.ai.sev-critical { border-left-color:var(--accent) } /* dotted style already signals AI; keep the accent hue */
.finding-head { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px }
/* Which page this instance is on. It is the one fact the issue card header
   cannot state, so it leads the instance instead of the rule id. */
.where { font-family:var(--font-mono); font-size:12px; font-weight:600; color:var(--accent-text); text-decoration:none; border-bottom:1px solid var(--accent-soft); overflow-wrap:anywhere }
.where:hover { border-bottom-color:var(--accent-text) }
.where:focus-visible { outline:2px solid var(--accent-text); outline-offset:2px }
.badge { font-family:var(--font-mono); font-size:11px; font-weight:700; padding:3px 8px; border-radius:4px; letter-spacing:.02em; text-transform:uppercase }
.badge.det { background:var(--surface-2); color:var(--text-2) }
.badge.soon { background:var(--accent-soft); color:var(--accent-text); vertical-align:middle; margin-left:10px }

/* ------------------------------------------------------- coming soon
   Placeholders for the judgment checks a rules engine cannot do. Muted and
   obviously inert: this is an honest "not yet", not a teaser withholding
   something that already exists. */
.ghosts { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin-top:16px }
/* No opacity on the card: dimming the container dragged this text to 3.24:1,
   under the 4.5:1 floor — our own axe run caught it. The dashed border and the
   placeholder lines carry the "inert" reading without touching legibility. */
.ghost { border:1px dashed var(--line-strong); border-radius:4px; padding:16px; background:var(--surface) }
.ghost-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px }
.ghost-head b { font-size:15px }
.ghost .lock { font-size:13px; color:var(--text-3) }
.ghost p { color:var(--text-2); font-size:13.5px; margin:0 0 12px; line-height:1.55 }
.ghost-lines { display:grid; gap:6px }
.ghost-lines i { display:block; height:7px; border-radius:999px; background:var(--surface-2) }
.ghost-lines i:nth-child(2) { width:86% }
.ghost-lines i:nth-child(3) { width:62% }

/* ------------------------------------------------------------ colophon */
.colophon { border-top:1px solid var(--line); margin-top:56px; padding:28px 0 8px; color:var(--text-3); font-size:13px }
.colophon b { color:var(--text-2) }

/* ------------------------------------------------------------- printing
   "Save as PDF" is how this report reaches a client's inbox, so the printed
   form is a real deliverable, not a fallback. Ink-cheap, page-break aware,
   and it prints the destination of every link since a PDF cannot be clicked
   through in the same way. */
@media print {
  @page { margin:14mm 12mm }
  html { scroll-behavior:auto }
  body { background:#fff; font-size:11pt }
  .hero { background:#fff; color:var(--text); padding:0 0 18pt; border-bottom:2pt solid var(--text) }
  .hero .brand, .hero h1, .hero-stat b { color:var(--text) }
  .hero .brand .mark { background:var(--accent) }
  .hero .seed a { color:var(--accent-text); border:0 }
  .hero .meta-line, .hero-stat span, .brand-row .by { color:var(--text-3) }
  .hero-stats { border-left:1pt solid var(--line) }
  .hero-actions, .story-nav, .share-note, .filters, #support, #deeper { display:none !important }
  /* Print is one long column by definition; a masonry there fragments cards
     across page breaks for no gain. */
  .issue-grid { columns:1 }
  .issue { break-inside:avoid; page-break-inside:avoid; margin-bottom:10pt }
  .issue[hidden] { display:block !important } /* a filtered view must still print whole */
  main { padding:0 }
  section { break-inside:avoid; page-break-inside:avoid }
  .finding, .ghost, .fix-box { break-inside:avoid; page-break-inside:avoid }
  h2, h3 { break-after:avoid; page-break-after:avoid }
  details { display:block }
  details > summary { list-style:none }
  pre { white-space:pre-wrap; border:1pt solid var(--line) }
  .shot { max-height:70mm; object-fit:contain }
  /* A printed link is a dead end unless it says where it goes. */
  .desc a[href^="http"]::after, .coverage-table a[href^="http"]::after { content:" (" attr(href) ")"; font-size:8pt; color:var(--text-3) }
  .colophon { border-top:1pt solid var(--text-3) }
}
.badge.ai { background:var(--accent-soft); color:var(--accent-text) }
.badge.sev-critical { background:var(--sev-critical-bg); color:var(--sev-critical-fg) }
.badge.sev-serious { background:var(--sev-serious-bg); color:var(--sev-serious-fg) }
.badge.sev-moderate { background:var(--sev-moderate-bg); color:var(--sev-moderate-fg) }
.badge.sev-minor { background:var(--sev-minor-bg); color:var(--sev-minor-fg) }
.badge.wcag { background:var(--surface); border:1px solid var(--line-strong); color:var(--text-2) }
.badge.ok { background:var(--ok-soft); color:var(--ok) }
.badge.warn { background:#6b6b6b; color:#fff }
.finding-meta { font-size:12.5px; color:var(--text-3) }
.finding p.desc { margin:0 0 8px; color:var(--text-2); font-size:14.5px }
.finding .sel { font-size:12.5px; color:var(--text-3); margin:0 0 8px }
pre { background:#141413; color:#f5f0e8; padding:12px 14px; border-radius:4px; overflow-x:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; margin:8px 0 }
pre.after { background:#132518 }
img.shot { max-width:100%; border:1px solid var(--line); border-radius:4px; margin-top:8px }
.fix-box { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line) }
.fix-box h4 { margin:0 0 6px; font-size:13.5px; display:flex; gap:8px; align-items:center }

/* ----------------------------------------------------------- support ask
   Only ever rendered on the free public funnel's reports (see writeHtml's
   supportUrl option) — never on one an auditor forwards to a paying client. */
.support { margin-top:8px; background:var(--surface); border:1px solid var(--line); border-radius:4px; padding:24px 28px; display:flex; gap:20px; align-items:center; flex-wrap:wrap }
.support-copy { flex:1; min-width:260px }
.support-copy b { display:block; font-family:var(--font-display); font-weight:400; font-size:20px; margin-bottom:4px }
.support-copy p { margin:0; color:var(--text-2); font-size:14px; max-width:520px }
.support a.give { flex:none; display:inline-flex; align-items:center; gap:8px; font-weight:700; font-size:15px; background:var(--accent); color:var(--on-accent, #141413); text-decoration:none; border-radius:4px; padding:13px 22px }
.support a.give:hover { background:var(--accent-text); color:#fff }

/* ------------------------------------------------------ diff page basics
   writeDiffHtml() shares this stylesheet but has no dark hero of its own. */
main > h1 { font-family:var(--font-display); font-weight:400; font-size:clamp(28px,3.4vw,40px); margin:48px 0 8px; letter-spacing:-.01em }
.meta { color:var(--text-3); font-size:13.5px }
.diff-head { display:flex; gap:10px; align-items:baseline; margin:40px 0 12px }
.diff-head h2 { margin:0; font-size:22px }
.diff-head .n { font-family:var(--font-mono); font-size:13px; font-weight:700; padding:3px 9px; border-radius:999px }
.diff-head.fixed .n { background:var(--ok-soft); color:var(--ok) }
.diff-head.added .n { background:var(--sev-critical-bg); color:var(--sev-critical-fg) }
.diff-head.kept .n { background:var(--sev-serious-bg); color:var(--sev-serious-fg) }

/* ---------------------------------------------------------- reduced motion */
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.001ms!important; transition-duration:.001ms!important; scroll-behavior:auto!important } }
`;

const sourceClass = (f) => (f.source === 'ai' ? 'ai' : 'det');
const sevClass = (f) => `sev-${f.severity ?? 'minor'}`;

/**
 * One instance inside an issue card. The card header already states the rule,
 * the severity and MEASURED/ASSESSED, so repeating all three on every instance
 * is noise; what an instance uniquely answers is *where* - which page, which
 * element - and that was previously carried by the page accordion this
 * grouping replaced.
 */
function findingHtml(f, reportDir, groupTitle = null) {
  const shot = f.screenshotPath ? relative(reportDir, f.screenshotPath).replace(/\\/g, '/') : null;
  let where = f.pageUrl ?? '';
  try { const u = new URL(f.pageUrl); where = (u.pathname + u.search) || '/'; } catch {}
  const fix = f.fix;
  return `<div class="finding ${sourceClass(f)} ${sevClass(f)}">
  <div class="finding-head">
    ${f.pageUrl ? `<a class="where" href="${esc(f.pageUrl)}">${esc(where)}</a>` : ''}
    ${f.wcagCriterion ? `<a class="badge wcag" href="${understanding(f.wcagCriterion)}">WCAG ${esc(f.wcagCriterion)} ${esc(f.wcagLevel ?? '')}</a>` : ''}
    <span class="finding-meta">confidence ${f.confidence}${f.sources?.length > 1 ? ` · also ${esc(f.sources.join(', '))}` : ''}</span>
  </div>
  ${f.description && f.description !== groupTitle ? `<p class="desc">${esc(f.description)}</p>` : ''}
  ${f.domSelector ? `<div class="sel">selector: <code>${esc(f.domSelector)}</code></div>` : ''}
  ${f.computedStyles ? `<div class="sel">computed: <code>${esc(JSON.stringify(f.computedStyles))}</code></div>` : ''}
  <!-- tabindex, but no role: the snippet scrolls, so it must be keyboard
       reachable, and a report has dozens of them — giving each the same
       role="region" and label made dozens of identically-named landmarks,
       which is its own violation. Focusability is the whole requirement. -->
  ${f.htmlSnippet ? `<pre tabindex="0">${esc(f.htmlSnippet)}</pre>` : ''}
  ${shot ? `<img class="shot" src="${esc(shot)}" alt="Screenshot of the flagged element">` : ''}
  ${fix ? fixHtml(fix) : ''}
</div>`;
}

const FIX_BADGE = { verified: 'ok', regressed: 'sev-critical', unverified: 'warn', unresolved: 'warn', error: 'warn' };
const fixHtml = (fix) => `<div class="fix-box">
  <h4>Proposed fix <span class="badge ${FIX_BADGE[fix.verification] ?? 'warn'}">${esc((fix.verification ?? 'unverified').toUpperCase())}</span></h4>
  ${fix.verification !== 'verified' ? '<p class="finding-meta"><b>This is a suggestion, not a verified fix.</b></p>' : ''}
  <p class="finding-meta">${esc(fix.verifyNotes ?? '')}</p>
  <pre class="after">${esc(fix.after)}</pre>
  ${fix.explanation ? `<p class="finding-meta">${esc(fix.explanation)}</p>` : ''}
</div>`;

const COVERAGE_LABEL = {
  findings: '<span class="badge sev-critical">findings</span>',
  'checked-clean': '<span class="badge det">checked, nothing found</span>',
  'manual-only': '<span class="badge warn">manual check required</span>',
};

/** The section that stops "few findings" from reading as "accessible". */
function coverageHtml(cov) {
  if (!cov?.rows?.length) return '';
  const c = cov.counts;
  const pct = (n) => Math.round((n / c.total) * 100);
  const row = (r) =>
    `<tr><td>${esc(r.number)} ${esc(r.name)}</td><td>${esc(r.level)}</td><td>${COVERAGE_LABEL[r.status]}</td><td>${r.findings || ''}</td></tr>`;
  return `<div class="section-head">
    <span class="eyebrow">Why this isn't a clean bill of health</span>
    <h2>WCAG coverage — what a machine could actually check</h2>
    <p>Silence on a criterion means one of two very different things: a rule ran and found nothing,
    or no automated rule exists for it at all. This report never lets those look the same.</p>
  </div>
  <div class="coverage-bar" role="img" aria-label="${c.withFindings} of ${c.total} criteria have findings, ${c.checkedClean} were checked with nothing found, ${c.manualOnly} are manual-only">
    <i style="width:${pct(c.withFindings)}%;background:var(--sev-critical-fg)"></i>
    <i style="width:${pct(c.checkedClean)}%;background:var(--ok)"></i>
    <i style="width:${pct(c.manualOnly)}%;background:var(--line-strong)"></i>
  </div>
  <div class="coverage-key">
    <span><i class="dot" style="background:var(--sev-critical-fg)"></i>${c.withFindings} with findings</span>
    <span><i class="dot" style="background:var(--ok)"></i>${c.checkedClean} checked, clean</span>
    <span><i class="dot" style="background:var(--line-strong)"></i>${c.manualOnly} manual-only, no rule exists</span>
  </div>
  <p style="font-size:13.5px;color:var(--text-3);max-width:680px">${esc(COVERAGE_NOTE)}</p>
  <details class="coverage-detail"><summary>Per-criterion breakdown (${c.total} criteria)</summary>
  <div class="table-wrap" style="margin-top:10px"><table><tr><th>Criterion</th><th>Level</th><th>Status</th><th>Findings</th></tr>
  ${cov.rows.map(row).join('')}</table></div></details>`;
}

/** role="img" ring built from plain <circle> stroke-dasharray segments — the
 *  same technique as the brand's own "C" mark, so the report's centrepiece
 *  visual is recognisably Contrast's, not a generic dashboard chart. Colour
 *  alone never carries the data (1.4.1): the aria-label spells out every
 *  number, and the legend beside it repeats the same text. */
function severityRing(bySeverity) {
  const order = ['critical', 'serious', 'moderate', 'minor'];
  const colors = { critical: '#ff6b5c', serious: '#ffab5e', moderate: '#ffd873', minor: '#8a8a86' };
  const total = order.reduce((sum, k) => sum + (bySeverity[k] ?? 0), 0);
  const r = 50, c = 2 * Math.PI * r;
  let offset = 0;
  const segs = total
    ? order
        .filter((k) => bySeverity[k])
        .map((k) => {
          const len = (bySeverity[k] / total) * c;
          const el = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${colors[k]}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
          offset += len;
          return el;
        })
        .join('')
    : '';
  const label = total
    ? order.filter((k) => bySeverity[k]).map((k) => `${bySeverity[k]} ${k}`).join(', ')
    : 'no findings';
  const legend = order
    .filter((k) => bySeverity[k])
    .map((k) => `<span><i class="dot" style="background:${colors[k]}"></i>${bySeverity[k]} ${esc(k)}</span>`)
    .join('');
  return `<div class="ring-wrap">
    <svg viewBox="0 0 120 120" width="128" height="128" role="img" aria-label="Findings by severity: ${esc(label)}">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="16"/>
      ${segs}
    </svg>
    <div class="ring-legend">${legend}</div>
  </div>`;
}

/**
 * The free scanner's reports carry a support ask; an auditor's client-facing
 * deliverable must not. Same generator, so the caller decides — only
 * src/public/server.js passes supportUrl.
 */
function supportHtml(supportUrl, funding) {
  if (!supportUrl) return '';
  const bar = funding
    ? `<div class="coverage-bar" style="margin:14px 0 8px" role="img" aria-label="${funding.raised} of ${funding.target} raised">
         <i style="width:${funding.percent}%;background:var(--accent)"></i></div>
       <p class="finding-meta" style="margin:0">$${funding.raised} of $${funding.target} raised${funding.next ? ` · next at $${funding.next.at}: ${esc(funding.next.title)}` : ' · every goal met, thank you'}</p>`
    : '';
  return `<section id="support"><div class="support">
    <div class="support-copy">
      <b>This scan was free. Running it wasn't.</b>
      <p>Every scan drives a real browser on a real server. If this report told you something
      useful, a coffee keeps the scanner free for the next person.</p>
      ${bar}
    </div>
    <a class="give" href="${esc(supportUrl)}" target="_blank" rel="noopener"
       onclick="navigator.sendBeacon&&navigator.sendBeacon('/api/event', JSON.stringify({button:'report-footer',page:'report'}))">Buy me a coffee →</a>
  </div></section>`;
}

/**
 * The five judgment calls a rules engine structurally cannot make. They are the
 * ~60-70% of WCAG that automation misses, and they are what the paid tier is
 * for — so a free report shows them as visibly absent rather than pretending
 * the deterministic pass was the whole job.
 *
 * Placeholders only, until the unlock flow ships. Deliberately quotes no price:
 * pricing is commercial and lives outside this repo (see CLAUDE.md, Rule 2).
 * Like supportHtml(), this renders only when the caller opts in, so an
 * auditor's client-facing deliverable never shows a marketing panel.
 */
const DEEPER_CHECKS = [
  ['Alt-text quality', 'Whether the description conveys what the image actually communicates — not merely that an alt attribute exists.'],
  ['Focus visibility', 'Tabs through the page and looks at each stop, catching focus rings too faint or too small to follow.'],
  ['Text inside images', 'Finds words baked into graphics, where no screen reader or translation tool can reach them.'],
  ['Colour-only signalling', 'Flags state shown by colour alone — an error in red with no icon, label, or text.'],
  ['Reading order', 'Compares the visual order against the DOM order, where they disagree for someone using a screen reader.'],
];

function comingSoonHtml(show) {
  if (!show) return '';
  return `<section id="deeper">
    <h2>Deeper analysis <span class="badge soon">Coming soon</span></h2>
    <p class="lede">This report covers what can be measured automatically. These five checks need
    judgment about what a page <em>means</em> — they are the part of WCAG a rules engine cannot
    reach, and they are being built now.</p>
    <div class="ghosts">
      ${DEEPER_CHECKS.map(([title, why]) => `<div class="ghost">
        <div class="ghost-head"><b>${esc(title)}</b><span class="lock" aria-hidden="true">🔒</span></div>
        <p>${esc(why)}</p>
        <div class="ghost-lines"><i></i><i></i><i></i></div>
      </div>`).join('')}
    </div>
    <p class="finding-meta" style="margin-top:14px">Not yet available on any plan — nothing is
    being withheld from you today.</p>
  </section>`;
}

/**
 * The report is about the site that was scanned, not about which of our
 * services ran it. `clientId` is an internal handle — on a free scan it is
 * literally "contrast-public", which told the reader nothing and looked like
 * the report was about us.
 */
export function siteNameOf(run) {
  try {
    return new URL(run.seedUrl).hostname.replace(/^www\./, '');
  } catch {
    return run.seedUrl || run.clientId || 'this site';
  }
}

export function writeHtml(db, runId, path, catalogue = [], { supportUrl = null, funding = null, comingSoon = false } = {}) {
  const report = buildReport(db, runId, catalogue);
  const reportDir = dirname(path);
  const s = report.summary;
  const siteName = siteNameOf(report.run);

  // Grouped by ISSUE, not by page. A 990-finding run is usually about twenty
  // distinct problems repeated across a template — "the same broken ARIA
  // pattern, 55 times" is what a reader can act on, where 990 stacked cards
  // is what makes them close the tab. Pages become an attribute of the issue
  // rather than the top level of a nested accordion.
  const issues = new Map();
  for (const f of report.findings) {
    const key = `${f.ruleId ?? 'other'}|${f.severity}|${f.source === 'ai' ? 'ai' : 'det'}`;
    if (!issues.has(key)) {
      issues.set(key, {
        ruleId: f.ruleId ?? 'other', severity: f.severity ?? 'minor',
        source: f.source === 'ai' ? 'ai' : 'det',
        criterion: f.wcagCriterion, level: f.wcagLevel,
        title: f.description ?? f.ruleId ?? 'Finding',
        items: [], pages: new Set(),
      });
    }
    const g = issues.get(key);
    g.items.push(f);
    g.pages.add(f.pageUrl);
  }
  const issueList = [...issues.values()].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) || b.items.length - a.items.length
  );

  // Three examples, not twelve. An issue repeated 55 times is understood from
  // three instances plus the count; rendering a dozen snippets per card was
  // what made one open card 3,500px tall — the exact wall of text this
  // grouping exists to remove. The rest are in the JSON.
  const SHOWN = 3;
  const issuesHtml = issueList
    .map((g, i) => {
      const shown = g.items.slice(0, SHOWN);
      const rest = g.items.length - shown.length;
      return `<details class="issue" data-sev="${esc(g.severity)}" data-src="${g.source}" ${i === 0 ? 'open' : ''}>
    <summary>
      <span class="issue-bar" aria-hidden="true"></span>
      <span class="issue-top">
        <span class="badge sev-${esc(g.severity)}">${esc(g.severity)}</span>
        <span class="badge ${g.source === 'ai' ? 'ai' : 'det'}">${g.source === 'ai' ? 'ASSESSED' : 'MEASURED'}</span>
        ${g.criterion ? `<span class="badge wcag">WCAG ${esc(g.criterion)}${g.level ? ' ' + esc(g.level) : ''}</span>` : ''}
      </span>
      <b class="issue-title">${esc(g.title)}</b>
      <span class="issue-foot">
        <span class="issue-count">${g.items.length}×</span>
        <span>on ${g.pages.size} page${g.pages.size === 1 ? '' : 's'}</span>
        <span class="issue-rule">${esc(g.ruleId)}</span>
      </span>
    </summary>
    <div class="issue-body">
      ${shown.map((f) => findingHtml(f, reportDir, g.title)).join('')}
      ${rest > 0 ? `<p class="finding-meta">…and ${rest} more instance${rest === 1 ? '' : 's'} of the same issue. The full list is in the JSON download.</p>` : ''}
    </div>
  </details>`;
    })
    .join('');

  const sevCounts = SEVERITIES.map((sev) => [sev, issueList.filter((g) => g.severity === sev).length]).filter(([, n]) => n);
  const filterBar = `<div class="filters" role="group" aria-label="Filter issues">
    <button type="button" class="chip on" data-filter="all">All <span class="chip-n">${issueList.length}</span></button>
    ${sevCounts.map(([sev, n]) => `<button type="button" class="chip" data-filter="${sev}">${sev} <span class="chip-n">${n}</span></button>`).join('')}
    <span class="filters-sep" aria-hidden="true"></span>
    <button type="button" class="chip" data-filter="det">Measured <span class="chip-n">${issueList.filter((g) => g.source === 'det').length}</span></button>
    <button type="button" class="chip" data-filter="ai">Assessed <span class="chip-n">${issueList.filter((g) => g.source === 'ai').length}</span></button>
    <button type="button" class="chip chip-ghost" id="expand-all">Expand all</button>
  </div>`;

  const pagesHtml = issueList.length ? filterBar + `<div class="issue-grid">${issuesHtml}</div>` : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility audit — ${esc(siteName)}</title><style>${CSS}</style></head>
<body>
<header class="hero">
  <div class="hero-inner">
    <div class="brand-row">
      <div class="brand"><span class="mark" data-state="idle"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg></span>Contrast</div>
      <!-- Same gate as the colophon at the foot of the page: an auditor hands
           this report to their own client, and it is not ours to co-brand.
           Only the free public funnel's own reports carry the org mark. -->
      ${comingSoon || supportUrl ? '<span class="by">by Vimoksh</span>' : ''}
      <div class="hero-actions">
        <button type="button" class="act act-primary" id="share-btn">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/></svg>
          Share report
        </button>
        <button type="button" class="act" id="print-btn">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4v-7h16v7h-2"/><path d="M8 15h8v6H8z"/></svg>
          Save as PDF
        </button>
        <a class="act" href="report.json" download="accessibility-report.json">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 21h16"/></svg>
          Data (JSON)
        </a>
      </div>
    </div>
    <span class="eyebrow">Accessibility Audit Report</span>
    <h1>${esc(siteName)}</h1>
    <p class="seed"><a href="${esc(report.run.seedUrl)}" target="_blank" rel="noopener">${esc(report.run.seedUrl)}</a></p>
    <p class="meta-line">generated ${esc(new Date(report.generatedAt).toLocaleString())} · <code style="color:#8d8a83">${esc(runId)}</code></p>
    <p class="share-note" id="share-note" role="status" hidden></p>
    ${report.run.notes ? `<div class="hero-abandoned"><b>This run did not complete as expected.</b> ${esc(report.run.notes)}</div>` : ''}
    <div class="hero-grid">
      ${severityRing(s.bySeverity)}
      <div class="hero-stats">
        <div class="hero-stat"><b data-to="${s.findings}">0</b><span>total finding${s.findings === 1 ? '' : 's'}</span></div>
        <div class="hero-stat accent"><b data-to="${s.aiAssessed}">0</b><span>need your judgment</span></div>
        <div class="hero-stat"><b data-to="${s.pages}">0</b><span>page${s.pages === 1 ? '' : 's'} scanned</span></div>
        <div class="hero-stat ok"><b data-to="${s.fixes.verified}">0</b><span>fix${s.fixes.verified === 1 ? '' : 'es'} verified</span></div>
      </div>
    </div>
  </div>
</header>

<nav class="story-nav"><div class="story-nav-inner">
  <a href="#overview">Overview</a><a href="#coverage">Coverage</a><a href="#findings">Findings</a>
  ${report.reviewQueue.length ? '<a href="#escalated">Escalated</a>' : ''}
</div></nav>

<main>
<section id="overview">
  <div class="section-head">
    <span class="eyebrow">What this report actually tells you</span>
    <h2>Measured facts and judgment calls, never blurred together</h2>
    <p>${esc(LIMITS_NOTICE)}</p>
  </div>
  <div class="demo" aria-hidden="true">
    <div class="demo-row det"><span class="dtag det">MEASURED</span><p>Button has no accessible name — axe-core, confidence 1.0. This is a fact: fix it, done.</p></div>
    <div class="demo-row ai"><span class="dtag ai">ASSESSED</span><p>Alt text says "image1.jpg" — an AI judgment call, needs your confirmation before you act on it.</p></div>
  </div>
</section>

<section id="coverage">${coverageHtml(report.coverage)}</section>

<section id="findings">
  <div class="section-head">
    <span class="eyebrow">Grouped by issue, worst first</span>
    <h2>Findings</h2>
    <p>One card per distinct problem, not per occurrence &mdash; the same broken pattern repeated across a template is one thing to fix, not fifty. Open a card for examples, the exact selector, and a WCAG citation you can hand straight to a developer.</p>
  </div>
  ${pagesHtml || '<p style="color:var(--text-2)">No findings recorded.</p>'}
</section>

${report.reviewQueue.length ? `<section id="escalated">
  <div class="section-head"><span class="eyebrow">Nothing here was silently dropped</span><h2>Escalated to human review (${report.reviewQueue.length})</h2></div>
  <div class="table-wrap"><table><tr><th>Finding</th><th>Reason</th></tr>${report.reviewQueue.map((r) => `<tr><td><code>${esc(r.findingId)}</code></td><td>${esc(r.reason)}</td></tr>`).join('')}</table></div>
</section>` : ''}
${comingSoonHtml(comingSoon)}
${supportHtml(supportUrl, funding)}
${comingSoon || supportUrl ? `<p class="colophon"><b>Contrast</b> — an accessibility auditing tool by <b>Vimoksh</b>.
  Built to say what it checked, and what it could not.</p>` : ''}
</main>
<script>
// Sharing a report is the single most common thing a reader wants to do with
// one, and "copy the address bar" is not a feature. Native share sheet where
// the device has one (every phone), clipboard everywhere else.
(function(){
  var note = document.getElementById('share-note');
  var say = function(msg){ if(!note) return; note.textContent = msg; note.hidden = false;
    clearTimeout(say.t); say.t = setTimeout(function(){ note.hidden = true; }, 4000); };

  var share = document.getElementById('share-btn');
  if (share) share.addEventListener('click', async function(){
    var url = location.href;
    var data = { title: document.title, text: 'Accessibility audit for ${esc(siteName)}', url: url };
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(url);
      say('Link copied — paste it anywhere to share this report.');
    } catch (err) {
      // AbortError just means the user closed the share sheet; not a failure.
      if (err && err.name === 'AbortError') return;
      // Last resort for browsers with no clipboard API on an insecure origin.
      window.prompt('Copy this link to share the report:', url);
    }
  });

  var print = document.getElementById('print-btn');
  if (print) print.addEventListener('click', function(){
    // Everything is expanded first, or the PDF silently loses every finding
    // hidden inside a collapsed <details>.
    document.querySelectorAll('details').forEach(function(d){ d.open = true; });
    window.print();
  });
})();

// Filtering the issue cards. Everything is already in the DOM, so this is a
// hidden attribute and nothing else — no re-render, no state to keep in sync.
(function(){
  var cards = Array.prototype.slice.call(document.querySelectorAll('.issue'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-filter]'));
  if (!cards.length) return;

  chips.forEach(function(chip){
    chip.setAttribute('aria-pressed', chip.classList.contains('on') ? 'true' : 'false');
    chip.addEventListener('click', function(){
      var f = chip.dataset.filter;
      chips.forEach(function(c){
        var on = c === chip;
        c.classList.toggle('on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      cards.forEach(function(card){
        card.hidden = !(f === 'all' || card.dataset.sev === f || card.dataset.src === f);
      });
    });
  });

  var expand = document.getElementById('expand-all');
  if (expand) expand.addEventListener('click', function(){
    // One button, both directions — a separate "collapse all" is a second
    // control for a state the label can just carry.
    var opening = expand.textContent.trim() === 'Expand all';
    cards.forEach(function(c){ if (!c.hidden) c.open = opening; });
    expand.textContent = opening ? 'Collapse all' : 'Expand all';
  });
})();

(function(){
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.hero-stat b[data-to]').forEach(function(el){
    var target = Number(el.dataset.to) || 0;
    if (reduced) { el.textContent = target; return; }
    var t0 = performance.now(), dur = 900;
    (function tick(now){
      var t = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(tick);
    })(t0);
  });
})();
</script>
</body></html>`;

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path, html);
  return path;
}

// ------------------------------------------------------------------ diff

/** Compare two runs by fingerprint: what got fixed, what is new, what persists. */
export function diffRuns(db, baseRunId, headRunId) {
  const base = getFindings(db, baseRunId);
  const head = getFindings(db, headRunId);
  const index = (list) => {
    const m = new Map();
    for (const f of list) m.set(f.fingerprint, f);
    return m;
  };
  const b = index(base);
  const h = index(head);
  return {
    baseRunId,
    headRunId,
    fixed: [...b.values()].filter((f) => !h.has(f.fingerprint)),
    new: [...h.values()].filter((f) => !b.has(f.fingerprint)),
    stillBroken: [...h.values()].filter((f) => b.has(f.fingerprint)),
    counts: { base: base.length, head: head.length },
  };
}

export function writeDiffHtml(db, baseRunId, headRunId, path) {
  const d = diffRuns(db, baseRunId, headRunId);
  const section = (title, list, cls) =>
    `<div class="diff-head ${cls}"><h2>${title}</h2><span class="n">${list.length}</span></div>` +
    (list.length
      ? `<div class="table-wrap"><table><tr><th>Page</th><th>WCAG</th><th>Rule</th><th>Severity</th><th>Selector</th></tr>${list
          .map(
            (f) =>
              `<tr><td>${esc(f.pageUrl)}</td><td>${esc(f.wcagCriterion ?? '-')}</td><td>${esc(f.ruleId)}</td><td><span class="badge sev-${esc(f.severity ?? 'minor')}">${esc(f.severity)}</span></td><td><code>${esc(f.domSelector ?? '-')}</code></td></tr>`
          )
          .join('')}</table></div>`
      : '<p class="meta">none</p>');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit diff ${esc(baseRunId)} → ${esc(headRunId)}</title><style>${CSS}</style></head><body><main>
<h1>Re-audit diff</h1>
<p class="meta">base <code>${esc(baseRunId)}</code> (${d.counts.base} findings) → head <code>${esc(headRunId)}</code> (${d.counts.head} findings)</p>
<div class="notice">${esc(LIMITS_NOTICE)}</div>
${section('Fixed since base', d.fixed, 'fixed')}
${section('New in head', d.new, 'added')}
${section('Still broken', d.stillBroken, 'kept')}
</main></body></html>`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  return path;
}

// ------------------------------------------------------------------ VPAT

const VPAT_LEVELS = ['A', 'AA'];

/**
 * VPAT/ACR **first draft**. Derived mechanically from findings — a human auditor
 * must complete manual criteria and rewrite the remarks before this goes near a
 * client. Criteria with no automated coverage are marked "Not Evaluated", never
 * "Supports".
 */
export function buildVpat(db, runId, criteriaCatalogue) {
  const run = getRun(db, runId);
  const findings = getFindings(db, runId);
  const byCriterion = new Map();
  for (const f of findings) {
    if (!f.wcagCriterion) continue;
    if (!byCriterion.has(f.wcagCriterion)) byCriterion.set(f.wcagCriterion, []);
    byCriterion.get(f.wcagCriterion).push(f);
  }

  const auto = automatedCriteria();
  const rows = criteriaCatalogue
    .filter((c) => VPAT_LEVELS.includes(c.level))
    .map((c) => {
      const hits = byCriterion.get(c.number) ?? [];
      const deterministic = hits.filter((f) => f.source !== 'ai');
      const conformance = hits.length === 0 ? 'Not Evaluated' : deterministic.length ? 'Does Not Support' : 'Partially Supports';
      // "Nothing found" and "nothing could be looked for" are very different
      // facts, and only one of them is worth an auditor's time first.
      const remark =
        hits.length === 0
          ? auto.has(c.number)
            ? 'Automated rules for this criterion ran and reported nothing. That is not conformance — a human must still confirm it.'
            : 'No automated rule covers this criterion at all — requires manual/assistive-technology evaluation.'
          : `${hits.length} finding(s) across ${new Set(hits.map((f) => f.pageUrl)).size} page(s)` +
            (deterministic.length ? `, ${deterministic.length} measured by automated tooling` : ', all AI-assessed and pending auditor confirmation');
      return { ...c, conformance, remark, findings: hits.length, automated: auto.has(c.number) };
    });

  const md = `# Accessibility Conformance Report — DRAFT

**Product:** ${run?.seedUrl ?? ''}
**Client:** ${run?.clientId ?? ''}
**Run:** ${runId}
**Generated:** ${new Date().toISOString()}

> **THIS IS A MACHINE-GENERATED FIRST DRAFT, NOT A COMPLETED ACR.**
> ${LIMITS_NOTICE}
> Every row marked "Not Evaluated" requires manual evaluation by a human auditor.
> Do not send this to a client until an auditor has completed and signed it.

## WCAG 2.2 Level A and AA

| Criterion | Level | Conformance (draft) | Remarks |
|---|---|---|---|
${rows.map((r) => `| ${r.number} ${r.name} | ${r.level} | ${r.conformance} | ${r.remark} |`).join('\n')}

## Summary of automated coverage

- Criteria with automated findings: ${rows.filter((r) => r.findings > 0).length}
- Criteria checked automatically with nothing found (still need a human): ${rows.filter((r) => r.findings === 0 && r.automated).length}
- Criteria no automated rule can cover (manual evaluation required): ${rows.filter((r) => !r.automated).length}
- Total findings: ${findings.length} (${findings.filter((f) => f.source !== 'ai').length} deterministic, ${findings.filter((f) => f.source === 'ai').length} AI-assessed)
`;
  return { markdown: md, rows };
}

export function writeVpat(db, runId, path, catalogue) {
  const { markdown } = buildVpat(db, runId, catalogue);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
  return path;
}

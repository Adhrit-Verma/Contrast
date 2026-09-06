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
code { font-family:var(--font-mono); font-size:.9em }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px }

/* --------------------------------------------------------------- hero
   Full-bleed dark cover, like a real audit's title page, before settling
   into the light body — the report's own "measured vs assessed" story
   starts the instant you land on it, not three scrolls in. */
.hero { background:var(--text); color:var(--canvas); padding:56px 40px 64px }
.hero-inner { max-width:1440px; margin:0 auto }
.hero .brand { display:flex; align-items:center; gap:9px; font-family:var(--font-display); font-size:17px; margin-bottom:36px; opacity:.85 }
.hero .brand .mark { width:24px; height:24px; border-radius:7px; background:var(--accent); display:grid; place-items:center; flex:none }
.hero .brand .mark svg { width:14px; height:14px }
.eyebrow { font-family:var(--font-mono); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#e0a794; margin:0 0 10px }
.hero h1 { font-family:var(--font-display); font-weight:400; font-size:clamp(32px,5vw,54px); line-height:1.1; margin:0 0 10px; letter-spacing:-.01em }
.hero .seed { font-family:var(--font-mono); font-size:15px; color:#d6d3cc; margin:0 0 6px; word-break:break-all }
.hero .meta-line { font-size:13px; color:#a09d96; margin:0 0 40px }
.hero-abandoned { background:rgba(255,107,92,.12); border:1px solid rgba(255,107,92,.35); border-radius:10px; padding:14px 18px; margin:0 0 32px; font-size:14px; color:#ffd4cc }
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
.demo { background:var(--surface); border:1px solid var(--line); border-radius:14px; overflow:hidden; box-shadow:0 1px 2px rgba(20,20,19,.05); max-width:900px }
.demo-row { display:flex; gap:12px; align-items:flex-start; padding:16px 18px }
.demo-row + .demo-row { border-top:1px solid var(--line) }
.demo-row.det { border-left:3px solid var(--text-2) }
.demo-row.ai { border-left:4px dotted var(--accent) }
.dtag { flex:none; font-family:var(--font-mono); font-size:11px; font-weight:700; padding:4px 9px; border-radius:6px; letter-spacing:.02em }
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
.table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--surface) }
table { border-collapse:collapse; width:100%; font-size:14px }
th,td { padding:10px 14px; text-align:left; border-bottom:1px solid var(--line) }
th { background:var(--surface-2); font-weight:700; color:var(--text) }
tr:last-child td { border-bottom:0 }
details.coverage-detail { margin-top:8px }
details.coverage-detail summary { cursor:pointer; font-size:13.5px; font-weight:600; color:var(--accent-text); padding:6px 0 }

/* -------------------------------------------------------------- findings
   Grouped by page, then component, via native <details> — an accordion that
   still works if CSS fails to load, and doesn't choke on a 990-finding run. */
.page-group { margin-bottom:16px }
.page-group > summary { cursor:pointer; font-family:var(--font-mono); font-size:14px; padding:14px 18px; background:var(--surface); border:1px solid var(--line); border-radius:12px; font-weight:600; display:flex; gap:10px; align-items:center }
.page-group > summary .count { margin-left:auto; font-weight:400; color:var(--text-3) }
.page-group[open] > summary { border-radius:12px 12px 0 0 }
.page-group-body { border:1px solid var(--line); border-top:0; border-radius:0 0 12px 12px; padding:6px 18px 18px }
.component { margin-top:14px }
.component > summary { cursor:pointer; font-size:13.5px; font-weight:600; color:var(--text-2); padding:8px 0 }

.finding { border-left:3px solid var(--text-3); background:var(--surface); border-radius:0 10px 10px 0; padding:16px 18px; margin:10px 0 }
.finding.ai { border-left-style:dotted; border-left-width:4px; border-left-color:var(--accent) }
.finding.sev-critical { border-left-color:var(--sev-critical-fg) }
.finding.sev-serious { border-left-color:var(--sev-serious-fg) }
.finding.sev-moderate { border-left-color:var(--sev-moderate-fg) }
.finding.sev-minor { border-left-color:var(--sev-minor-fg) }
.finding.ai.sev-critical { border-left-color:var(--accent) } /* dotted style already signals AI; keep the accent hue */
.finding-head { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px }
.badge { font-family:var(--font-mono); font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px; letter-spacing:.02em; text-transform:uppercase }
.badge.det { background:var(--surface-2); color:var(--text-2) }
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
pre { background:#141413; color:#f5f0e8; padding:12px 14px; border-radius:8px; overflow-x:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; margin:8px 0 }
pre.after { background:#132518 }
img.shot { max-width:100%; border:1px solid var(--line); border-radius:8px; margin-top:8px }
.fix-box { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line) }
.fix-box h4 { margin:0 0 6px; font-size:13.5px; display:flex; gap:8px; align-items:center }

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

function findingHtml(f, reportDir) {
  const shot = f.screenshotPath ? relative(reportDir, f.screenshotPath).replace(/\\/g, '/') : null;
  const fix = f.fix;
  return `<div class="finding ${sourceClass(f)} ${sevClass(f)}">
  <div class="finding-head">
    <span class="badge ${sourceClass(f)}">${f.source === 'ai' ? 'ASSESSED' : 'MEASURED'}</span>
    <span class="badge ${sevClass(f)}">${esc(f.severity)}</span>
    ${f.wcagCriterion ? `<a class="badge wcag" href="${understanding(f.wcagCriterion)}">WCAG ${esc(f.wcagCriterion)} ${esc(f.wcagLevel ?? '')}</a>` : ''}
    <span class="finding-meta">${esc(f.ruleId)} · confidence ${f.confidence}${f.sources?.length > 1 ? ` · also ${esc(f.sources.join(', '))}` : ''}</span>
  </div>
  <p class="desc">${esc(f.description)}</p>
  ${f.domSelector ? `<div class="sel">selector: <code>${esc(f.domSelector)}</code></div>` : ''}
  ${f.computedStyles ? `<div class="sel">computed: <code>${esc(JSON.stringify(f.computedStyles))}</code></div>` : ''}
  ${f.htmlSnippet ? `<pre>${esc(f.htmlSnippet)}</pre>` : ''}
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

export function writeHtml(db, runId, path, catalogue = []) {
  const report = buildReport(db, runId, catalogue);
  const reportDir = dirname(path);
  const s = report.summary;

  const byPage = new Map();
  for (const f of report.findings) {
    if (!byPage.has(f.pageUrl)) byPage.set(f.pageUrl, new Map());
    const comp = (f.domSelector ?? '').split(' > ').slice(0, 2).join(' > ') || 'page-level';
    const groups = byPage.get(f.pageUrl);
    if (!groups.has(comp)) groups.set(comp, []);
    groups.get(comp).push(f);
  }

  // A collapsed accordion inside a collapsed accordion hides the entire point
  // of the report. Open everything on a small run; on a 900-finding one, open
  // the first page and the worst components so the reader lands on real
  // content, not a wall of disclosure triangles.
  const totalFindings = report.findings.length;
  const openAll = totalFindings <= 60;

  const pagesHtml = [...byPage.entries()]
    .map(([url, groups], pageIdx) => {
      const total = [...groups.values()].flat().length;
      const sorted = [...groups.entries()].map(([comp, list]) => {
        list.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
        return [comp, list];
      });
      // worst-first, so "the first few open" means the ones that matter
      sorted.sort((a, b) => (SEV_ORDER[a[1][0].severity] ?? 9) - (SEV_ORDER[b[1][0].severity] ?? 9));
      const inner = sorted
        .map(([comp, list], compIdx) => {
          const open = openAll || (pageIdx === 0 && compIdx < 5);
          const worst = list[0].severity ?? 'minor';
          return `<details class="component" ${open ? 'open' : ''}><summary><span class="badge sev-${esc(worst)}">${esc(worst)}</span> ${esc(comp)} — ${list.length}</summary>${list.map((f) => findingHtml(f, reportDir)).join('')}</details>`;
        })
        .join('');
      return `<details class="page-group" ${openAll || pageIdx < 3 ? 'open' : ''}><summary>${esc(url)} <span class="count">${total} finding${total === 1 ? '' : 's'}</span></summary><div class="page-group-body">${inner}</div></details>`;
    })
    .join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility audit — ${esc(report.run.clientId)} — ${esc(runId)}</title><style>${CSS}</style></head>
<body>
<header class="hero">
  <div class="hero-inner">
    <div class="brand"><span class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 000 16z" fill="#141413"/></svg></span>Contrast</div>
    <span class="eyebrow">Accessibility Audit Report</span>
    <h1>${esc(report.run.clientId)}</h1>
    <p class="seed">${esc(report.run.seedUrl)}</p>
    <p class="meta-line">run <code style="color:#d6d3cc">${esc(runId)}</code> · generated ${esc(new Date(report.generatedAt).toLocaleString())}</p>
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
    <span class="eyebrow">Sorted worst first, grouped by page</span>
    <h2>Findings</h2>
    <p>Every finding below carries its own certainty badge and, where one exists, a WCAG citation you can hand straight to a developer.</p>
  </div>
  ${pagesHtml || '<p style="color:var(--text-2)">No findings recorded.</p>'}
</section>

${report.reviewQueue.length ? `<section id="escalated">
  <div class="section-head"><span class="eyebrow">Nothing here was silently dropped</span><h2>Escalated to human review (${report.reviewQueue.length})</h2></div>
  <div class="table-wrap"><table><tr><th>Finding</th><th>Reason</th></tr>${report.reviewQueue.map((r) => `<tr><td><code>${esc(r.findingId)}</code></td><td>${esc(r.reason)}</td></tr>`).join('')}</table></div>
</section>` : ''}
</main>
<script>
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

// Phase 6. Plain string templating — a report viewer is not a product UI.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { getFindings, getRun, getPages, getFixes, getReviewQueue } from '../db.js';

export const LIMITS_NOTICE =
  'Automated testing detects roughly 30–40% of WCAG issues. This report is NOT a claim of ' +
  'conformance. Findings marked AI-assessed are judgments, not measurements, and every one ' +
  'needs auditor confirmation. Absence of findings is not evidence of accessibility.';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SEV_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const understanding = (c) => (c ? `https://www.w3.org/WAI/WCAG22/Understanding/${c}` : null);

export function buildReport(db, runId) {
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

export function writeJson(db, runId, path) {
  const report = buildReport(db, runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

// ------------------------------------------------------------------ HTML

export const CSS = `
/* Severity colours all carry white text: measured >= 4.5:1 (1.4.3). Keep in
   step with src/ui/public/app.css — two documents, one palette. */
:root { --det:#0b5394; --ai:#8b3fa8; --crit:#b3261e; --ser:#a34e00; --mod:#7a6000; --min:#4a4a4a; }
* { box-sizing:border-box }
body { font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; margin:0; color:#141414; background:#f6f7f9 }
main { max-width:1100px; margin:0 auto; padding:24px }
h1,h2,h3 { line-height:1.25 }
.notice { background:#fff4e5; border-left:5px solid #c85a00; padding:12px 16px; margin:16px 0 }
.cards { display:flex; flex-wrap:wrap; gap:12px; margin:16px 0 }
.card { background:#fff; border:1px solid #dcdfe4; border-radius:6px; padding:12px 16px; min-width:130px }
.card b { display:block; font-size:24px }
details { background:#fff; border:1px solid #dcdfe4; border-radius:6px; margin:10px 0 }
details > summary { cursor:pointer; padding:10px 14px; font-weight:600 }
.finding { border-top:1px solid #eceef1; padding:14px }
.finding.ai { border-left:5px solid var(--ai); background:#fbf7fd }
.finding.det { border-left:5px solid var(--det) }
.tag { display:inline-block; font-size:12px; font-weight:700; padding:2px 8px; border-radius:10px; margin-right:6px; color:#fff }
.tag.ai { background:var(--ai) } .tag.det { background:var(--det) }
.tag.critical { background:var(--crit) } .tag.serious { background:var(--ser) }
.tag.moderate { background:var(--mod) } .tag.minor { background:var(--min) }
.tag.verified { background:#1e7a3c } .tag.regressed { background:var(--crit) }
.tag.unverified,.tag.unresolved,.tag.error { background:#6b6b6b }
pre { background:#1e1f22; color:#e6e6e6; padding:10px; border-radius:5px; overflow:auto; font-size:12.5px; margin:6px 0 }
pre.after { background:#0f2f18 }
code { font-family:ui-monospace,Consolas,monospace }
img.shot { max-width:100%; border:1px solid #ccc; border-radius:4px; margin-top:8px }
table { border-collapse:collapse; width:100%; background:#fff }
th,td { border:1px solid #dcdfe4; padding:6px 10px; text-align:left; font-size:14px }
.meta { color:#555; font-size:13px }
.legend span { margin-right:16px }
`;

const sourceClass = (f) => (f.source === 'ai' ? 'ai' : 'det');

function findingHtml(f, reportDir) {
  const shot = f.screenshotPath ? relative(reportDir, f.screenshotPath).replace(/\\/g, '/') : null;
  const fix = f.fix;
  return `<div class="finding ${sourceClass(f)}">
  <div>
    <span class="tag ${sourceClass(f)}">${f.source === 'ai' ? 'AI-ASSESSED' : 'DETERMINISTIC'}</span>
    <span class="tag ${esc(f.severity)}">${esc(f.severity)}</span>
    ${f.wcagCriterion ? `<a href="${understanding(f.wcagCriterion)}">WCAG ${esc(f.wcagCriterion)} ${esc(f.wcagLevel ?? '')}</a>` : '<span class="meta">no mapped criterion</span>'}
    <span class="meta">· ${esc(f.ruleId)} · confidence ${f.confidence}${f.sources?.length > 1 ? ` · also ${esc(f.sources.join(', '))}` : ''}</span>
  </div>
  <p>${esc(f.description)}</p>
  ${f.domSelector ? `<div class="meta">selector: <code>${esc(f.domSelector)}</code></div>` : ''}
  ${f.computedStyles ? `<div class="meta">computed: <code>${esc(JSON.stringify(f.computedStyles))}</code></div>` : ''}
  ${f.htmlSnippet ? `<pre>${esc(f.htmlSnippet)}</pre>` : ''}
  ${shot ? `<img class="shot" src="${esc(shot)}" alt="Screenshot of the flagged element">` : ''}
  ${fix ? fixHtml(fix) : ''}
</div>`;
}

const fixHtml = (fix) => `<div>
  <h4>Proposed fix <span class="tag ${esc(fix.verification ?? 'unverified')}">${esc((fix.verification ?? 'unverified').toUpperCase())}</span></h4>
  ${fix.verification !== 'verified' ? '<div class="meta"><b>This is a suggestion, not a verified fix.</b></div>' : ''}
  <div class="meta">${esc(fix.verifyNotes ?? '')}</div>
  <pre class="after">${esc(fix.after)}</pre>
  ${fix.explanation ? `<p class="meta">${esc(fix.explanation)}</p>` : ''}
</div>`;

export function writeHtml(db, runId, path) {
  const report = buildReport(db, runId);
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

  const pagesHtml = [...byPage.entries()]
    .map(([url, groups]) => {
      const total = [...groups.values()].flat().length;
      const inner = [...groups.entries()]
        .map(([comp, list]) => {
          list.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
          return `<details><summary>${esc(comp)} — ${list.length}</summary>${list.map((f) => findingHtml(f, reportDir)).join('')}</details>`;
        })
        .join('');
      return `<details open><summary>${esc(url)} — ${total} findings</summary><div style="padding:8px 12px">${inner}</div></details>`;
    })
    .join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility audit — ${esc(report.run.clientId)} — ${esc(runId)}</title><style>${CSS}</style></head>
<body><main>
<h1>Accessibility audit report</h1>
<p class="meta">Client <b>${esc(report.run.clientId)}</b> · run <code>${esc(runId)}</code> · seed ${esc(report.run.seedUrl)} · generated ${esc(report.generatedAt)}</p>
<div class="notice"><b>Scope and limits.</b> ${esc(LIMITS_NOTICE)}</div>
<div class="cards">
  <div class="card"><b>${s.findings}</b>findings</div>
  <div class="card"><b>${s.deterministic}</b>deterministic</div>
  <div class="card"><b>${s.aiAssessed}</b>AI-assessed</div>
  <div class="card"><b>${s.pages}</b>pages</div>
  <div class="card"><b>${s.fixes.verified}</b>verified fixes</div>
  <div class="card"><b>${s.fixes.unverified + s.fixes.regressed}</b>unverified / regressed</div>
</div>
<p class="legend"><span><span class="tag det">DETERMINISTIC</span> measured by axe / Lighthouse / the accessibility tree / keyboard trace — certain</span>
<span><span class="tag ai">AI-ASSESSED</span> judged by a model — needs auditor confirmation</span></p>
<h2>Severity</h2><table><tr>${Object.entries(s.bySeverity).map(([k, v]) => `<th>${esc(k)}</th>`).join('')}</tr><tr>${Object.entries(s.bySeverity).map(([, v]) => `<td>${v}</td>`).join('')}</tr></table>
<h2>Findings</h2>
${pagesHtml || '<p>No findings recorded.</p>'}
${report.reviewQueue.length ? `<h2>Escalated to human review (${report.reviewQueue.length})</h2><table><tr><th>Finding</th><th>Reason</th></tr>${report.reviewQueue.map((r) => `<tr><td><code>${esc(r.findingId)}</code></td><td>${esc(r.reason)}</td></tr>`).join('')}</table>` : ''}
</main></body></html>`;

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
  const section = (title, list, colour) =>
    `<h2 style="color:${colour}">${title} (${list.length})</h2>` +
    (list.length
      ? `<table><tr><th>Page</th><th>WCAG</th><th>Rule</th><th>Severity</th><th>Selector</th></tr>${list
          .map(
            (f) =>
              `<tr><td>${esc(f.pageUrl)}</td><td>${esc(f.wcagCriterion ?? '-')}</td><td>${esc(f.ruleId)}</td><td>${esc(f.severity)}</td><td><code>${esc(f.domSelector ?? '-')}</code></td></tr>`
          )
          .join('')}</table>`
      : '<p>none</p>');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Audit diff ${esc(baseRunId)} → ${esc(headRunId)}</title><style>${CSS}</style></head><body><main>
<h1>Re-audit diff</h1>
<p class="meta">base <code>${esc(baseRunId)}</code> (${d.counts.base} findings) → head <code>${esc(headRunId)}</code> (${d.counts.head} findings)</p>
<div class="notice">${esc(LIMITS_NOTICE)}</div>
${section('Fixed since base', d.fixed, '#1e7a3c')}
${section('New in head', d.new, '#b3261e')}
${section('Still broken', d.stillBroken, '#c85a00')}
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

  const rows = criteriaCatalogue
    .filter((c) => VPAT_LEVELS.includes(c.level))
    .map((c) => {
      const hits = byCriterion.get(c.number) ?? [];
      const deterministic = hits.filter((f) => f.source !== 'ai');
      const conformance = hits.length === 0 ? 'Not Evaluated' : deterministic.length ? 'Does Not Support' : 'Partially Supports';
      const remark =
        hits.length === 0
          ? 'No automated coverage for this criterion in this run — requires manual evaluation.'
          : `${hits.length} finding(s) across ${new Set(hits.map((f) => f.pageUrl)).size} page(s)` +
            (deterministic.length ? `, ${deterministic.length} measured by automated tooling` : ', all AI-assessed and pending auditor confirmation');
      return { ...c, conformance, remark, findings: hits.length };
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
- Criteria not evaluated automatically: ${rows.filter((r) => r.findings === 0).length}
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

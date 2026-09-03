#!/usr/bin/env node
// Accuracy harness. Runs the deterministic scanner against the W3C ACT Rules
// community test cases — free, public, pre-labelled HTML fixtures with a known
// expected outcome per WCAG criterion — and reports precision/recall.
//
//   node scripts/accuracy.mjs                 # bounded sample (default 120 cases)
//   node scripts/accuracy.mjs --all           # every approved test case (slow)
//   node scripts/accuracy.mjs --limit 300
//   node scripts/accuracy.mjs --rule 6cfa84   # one ACT rule
//   node scripts/accuracy.mjs --refresh       # re-fetch the test case index
//
// What this actually measures: the deterministic layer, which IS axe-core. It is
// not an independent detection engine, so a criterion scoring recall 0 means "no
// automated rule covers this" — which is the exact signal the report needs so it
// never implies coverage it does not have.
//
// Deliberately excluded: the a11y-tree and keyboard detectors. ACT fixtures are
// DOM fragments, so "no main landmark" fires on nearly every one — an artifact of
// the corpus, not a finding, and it would swamp 1.3.1 with false positives.
import puppeteer from 'puppeteer';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runAxe } from '../src/scan/collect.js';
import { normalize } from '../src/scan/normalize.js';
import { automatedCriteria } from '../src/report/index.js';

const INDEX_URL = 'https://act-rules.github.io/testcases.json';
const OUT = 'runs/act';
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const LIMIT = has('all') ? Infinity : Number(flag('limit', 120));
const ONLY_RULE = flag('rule');

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ test cases

async function loadIndex() {
  const cache = join(OUT, 'testcases.json');
  if (existsSync(cache) && !has('refresh')) return JSON.parse(readFileSync(cache, 'utf8'));
  process.stdout.write(`fetching ${INDEX_URL} … `);
  const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`could not fetch ACT test cases (HTTP ${res.status})`);
  const data = await res.json();
  writeFileSync(cache, JSON.stringify(data));
  console.log(`${data.testcases?.length ?? 0} cases cached → ${cache}`);
  return data;
}

/** The WCAG criteria an ACT test case is labelled against. */
const criteriaOf = (tc) =>
  Object.keys(tc.ruleAccessibilityRequirements ?? tc.accessibilityRequirements ?? {})
    .map((k) => /(\d+\.\d+\.\d+)/.exec(k)?.[1])
    .filter(Boolean);

// ------------------------------------------------------------------ run

const index = await loadIndex();
const all = (index.testcases ?? []).filter(
  (tc) => tc.url && criteriaOf(tc).length && tc.testCaseApproved !== false && (!ONLY_RULE || tc.ruleId === ONLY_RULE)
);
if (!all.length) {
  console.error('no usable ACT test cases — the index schema may have changed. Inspect runs/act/testcases.json');
  process.exit(1);
}
const cases = all.slice(0, LIMIT === Infinity ? all.length : LIMIT);
console.log(`${all.length} labelled cases available, running ${cases.length}\n`);

const auto = automatedCriteria();
const stats = new Map(); // criterion -> {tp, fp, fn, tn, incomplete}
const bump = (c, key) => {
  if (!stats.has(c)) stats.set(c, { tp: 0, fp: 0, fn: 0, tn: 0, incomplete: 0 });
  stats.get(c)[key]++;
};
const disagreements = [];
const errors = [];

const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1280, height: 900 } });
const page = await browser.newPage();
page.setDefaultNavigationTimeout(20000);

let done = 0;
for (const tc of cases) {
  done++;
  if (done % 25 === 0) process.stdout.write(`  … ${done}/${cases.length}\n`);
  let findings;
  try {
    await page.goto(tc.url, { waitUntil: 'domcontentloaded' });
    const axe = await runAxe(page);
    findings = normalize({ axe, lighthouse: { audits: [] }, tree: null, keyboard: [] }, {
      runId: 'act', pageUrl: tc.url, timestamp: new Date().toISOString(),
    });
  } catch (err) {
    errors.push({ testcaseId: tc.testcaseId, url: tc.url, message: err.message });
    continue;
  }

  // Only confident violations count as "flagged". axe's `incomplete` means it
  // could not decide, so scoring it as a detection would flatter the numbers.
  const flagged = new Set(findings.filter((f) => f.confidence === 1 && f.wcagCriterion).map((f) => f.wcagCriterion));
  const unsure = new Set(findings.filter((f) => f.confidence < 1 && f.wcagCriterion).map((f) => f.wcagCriterion));

  for (const c of criteriaOf(tc)) {
    const shouldFail = tc.expected === 'failed';
    const didFlag = flagged.has(c);
    if (unsure.has(c) && !didFlag) bump(c, 'incomplete');
    if (shouldFail && didFlag) bump(c, 'tp');
    else if (shouldFail && !didFlag) {
      bump(c, 'fn');
      disagreements.push({ kind: 'missed', criterion: c, ruleId: tc.ruleId, ruleName: tc.ruleName, expected: tc.expected, url: tc.url });
    } else if (!shouldFail && didFlag) {
      bump(c, 'fp');
      disagreements.push({ kind: 'false-alarm', criterion: c, ruleId: tc.ruleId, ruleName: tc.ruleName, expected: tc.expected, url: tc.url });
    } else bump(c, 'tn');
  }
}
await browser.close();

// -------------------------------------------------------------- results

const pct = (n) => (n === null ? '   —  ' : `${(n * 100).toFixed(0)}%`.padStart(6));
const rows = [...stats.entries()]
  .map(([criterion, s]) => {
    const precision = s.tp + s.fp ? s.tp / (s.tp + s.fp) : null;
    const recall = s.tp + s.fn ? s.tp / (s.tp + s.fn) : null;
    const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
    return { criterion, ...s, precision, recall, f1, cases: s.tp + s.fp + s.fn + s.tn, automated: auto.has(criterion) };
  })
  .sort((a, b) => a.criterion.localeCompare(b.criterion, undefined, { numeric: true }));

console.log('\ncriterion  cases   TP  FP  FN   precision  recall   note');
console.log('─'.repeat(78));
for (const r of rows) {
  const note = !r.automated ? 'no automated rule — manual only' : r.recall === 0 && r.tp + r.fn > 0 ? 'MISSES EVERYTHING' : r.precision !== null && r.precision < 0.9 ? 'false alarms' : '';
  console.log(
    `${r.criterion.padEnd(9)} ${String(r.cases).padStart(5)}  ${String(r.tp).padStart(3)} ${String(r.fp).padStart(3)} ${String(r.fn).padStart(3)}   ${pct(r.precision)}  ${pct(r.recall)}   ${note}`
  );
}

const totals = rows.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn, tn: a.tn + r.tn }), { tp: 0, fp: 0, fn: 0, tn: 0 });
const microP = totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : null;
const microR = totals.tp + totals.fn ? totals.tp / (totals.tp + totals.fn) : null;

console.log('─'.repeat(78));
console.log(`overall    ${String(totals.tp + totals.fp + totals.fn + totals.tn).padStart(5)}  ${String(totals.tp).padStart(3)} ${String(totals.fp).padStart(3)} ${String(totals.fn).padStart(3)}   ${pct(microP)}  ${pct(microR)}`);
console.log(`\n${cases.length} test cases, ${rows.length} criteria, ${errors.length} load errors`);
console.log(`${disagreements.filter((d) => d.kind === 'missed').length} missed, ${disagreements.filter((d) => d.kind === 'false-alarm').length} false alarms — logged for review`);

writeFileSync(join(OUT, 'accuracy.json'), JSON.stringify({ generatedAt: new Date().toISOString(), cases: cases.length, totals, rows, errors }, null, 2));
writeFileSync(join(OUT, 'disagreements.json'), JSON.stringify(disagreements, null, 2));
console.log(`\n→ ${join(OUT, 'accuracy.json')}\n→ ${join(OUT, 'disagreements.json')}`);

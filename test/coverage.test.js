// The report must never let silence read as conformance. These two facts —
// "a rule checked this and found nothing" and "nothing could check this at all"
// — are what the coverage section exists to keep apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { automatedCriteria, wcagCoverage } from '../src/report/index.js';
import { TASKS } from '../src/ai/tasks.js';

test('automated criteria are derived from axe metadata, not a hand-written table', () => {
  const auto = automatedCriteria();
  assert.ok(auto.has('1.1.1'), 'image-alt maps to 1.1.1');
  assert.ok(auto.has('1.4.3'), 'color-contrast maps to 1.4.3');
  assert.ok(auto.has('4.1.2'), 'button-name maps to 4.1.2');
  // Nothing automated can judge whether a submission is reversible.
  assert.ok(!auto.has('3.3.4'), '3.3.4 has no automated rule and must not be claimed');
});

test('rules axe ships but never runs are not counted as coverage', () => {
  // color-contrast-enhanced (AAA), label-content-name-mismatch (experimental)
  // and audio-caption (deprecated) all exist in axe and none of them fire by
  // default. The ACT harness proved it: each detected nothing across the corpus.
  const auto = automatedCriteria();
  assert.ok(!auto.has('1.4.6'), 'AAA-only rules are off by default');
  assert.ok(!auto.has('2.5.3'), 'experimental rules are off by default');
});

test('every AI task criterion is counted as covered', () => {
  // OWN_CRITERIA in report/index.js is hand-listed to keep Lighthouse out of the
  // report import chain — this is what stops it drifting from the real tasks.
  const auto = automatedCriteria();
  for (const t of TASKS) assert.ok(auto.has(t.wcag), `task ${t.name} claims ${t.wcag} but coverage omits it`);
});

test('coverage separates findings, checked-clean and manual-only', () => {
  const catalogue = [
    { number: '1.4.3', name: 'Contrast (Minimum)', level: 'AA' },
    { number: '1.1.1', name: 'Non-text Content', level: 'A' },
    { number: '3.3.4', name: 'Error Prevention', level: 'AA' },
  ];
  const cov = wcagCoverage([{ wcagCriterion: '1.4.3' }, { wcagCriterion: '1.4.3' }], catalogue);
  const row = (n) => cov.rows.find((r) => r.number === n);

  assert.equal(row('1.4.3').status, 'findings');
  assert.equal(row('1.4.3').findings, 2);
  assert.equal(row('1.1.1').status, 'checked-clean', 'a rule ran and found nothing');
  assert.equal(row('3.3.4').status, 'manual-only', 'no rule exists for this at all');
  assert.deepEqual(cov.counts, { total: 3, automated: 2, manualOnly: 1, withFindings: 1, checkedClean: 1 });
});

test('an empty catalogue degrades to no coverage section rather than a false claim', () => {
  const cov = wcagCoverage([{ wcagCriterion: '1.4.3' }], []);
  assert.deepEqual(cov.rows, []);
  assert.equal(cov.counts.total, 0);
});

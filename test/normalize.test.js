import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wcagFromTags, fromAxe, fromLighthouse, fromA11yTree, fromKeyboard,
  dedupe, normalize, maxSeverity, noVisibleFocus,
} from '../src/scan/normalize.js';

const ctx = { runId: 'r1', pageUrl: 'https://a.com/p', timestamp: 't' };

test('wcagFromTags maps axe tags to criterion + level', () => {
  assert.deepEqual(wcagFromTags(['cat.color', 'wcag143', 'wcag2aa']), { criterion: '1.4.3', level: 'AA' });
  assert.deepEqual(wcagFromTags(['wcag2410', 'wcag21aa']), { criterion: '2.4.10', level: 'AA' });
  assert.deepEqual(wcagFromTags(['wcag111', 'wcag2a']), { criterion: '1.1.1', level: 'A' });
  assert.deepEqual(wcagFromTags(['best-practice']), { criterion: null, level: null });
});

const axeResults = {
  violations: [{
    id: 'color-contrast', impact: 'serious', tags: ['wcag143', 'wcag2aa'],
    help: 'Elements must have sufficient contrast', helpUrl: 'https://x',
    nodes: [{ target: ['#a'], html: '<a id="a">x</a>', impact: 'serious', any: [{ data: { contrastRatio: 2.1, fgColor: '#777', bgColor: '#fff' } }] }],
  }],
  incomplete: [{
    id: 'color-contrast', tags: ['wcag143', 'wcag2aa'], help: 'check bg image', helpUrl: 'https://x',
    nodes: [{ target: ['#b'], html: '<b id="b">y</b>' }],
  }],
};

test('fromAxe emits violations at confidence 1.0 and incomplete at 0.5', () => {
  const [v, i] = fromAxe(axeResults, ctx);
  assert.equal(v.source, 'axe');
  assert.equal(v.wcagCriterion, '1.4.3');
  assert.equal(v.confidence, 1.0);
  assert.equal(v.raw.data.contrastRatio, 2.1);
  assert.equal(i.confidence, 0.5);
  assert.equal(i.needsReview, true);
  assert.match(i.ruleId, /:incomplete$/);
});

test('fromLighthouse borrows the WCAG mapping from axe rule metadata', () => {
  const lh = { audits: [{ id: 'color-contrast', score: 0, title: 'Contrast', details: { items: [{ node: { selector: '#a', snippet: '<a/>' } }] } }] };
  const [f] = fromLighthouse(lh, [{ ruleId: 'color-contrast', tags: ['wcag143', 'wcag2aa'] }], ctx);
  assert.equal(f.wcagCriterion, '1.4.3');
  assert.equal(f.wcagLevel, 'AA');
  assert.equal(f.severity, 'serious');
});

test('dedupe collapses axe+lighthouse on the same selector+criterion, keeps axe', () => {
  const merged = normalize(
    {
      axe: { ...axeResults, ruleMeta: [{ ruleId: 'color-contrast', tags: ['wcag143', 'wcag2aa'] }] },
      lighthouse: { audits: [{ id: 'color-contrast', score: 0, title: 'Contrast', details: { items: [{ node: { selector: '#a' } }] } }] },
      tree: null,
      keyboard: [],
    },
    ctx
  );
  const contrastOnA = merged.filter((f) => f.domSelector === '#a' && f.wcagCriterion === '1.4.3');
  assert.equal(contrastOnA.length, 1, 'must not report the same issue twice');
  assert.equal(contrastOnA[0].source, 'axe');
  assert.deepEqual(contrastOnA[0].sources.sort(), ['axe', 'lighthouse']);
});

test('dedupe never merges findings without a selector or criterion', () => {
  const noSel = [
    { pageUrl: 'p', domSelector: null, wcagCriterion: '1.1.1', source: 'a11y-tree', severity: 'serious' },
    { pageUrl: 'p', domSelector: null, wcagCriterion: '1.1.1', source: 'a11y-tree', severity: 'serious' },
    { pageUrl: 'p', domSelector: '#x', wcagCriterion: null, source: 'axe', severity: 'minor' },
  ];
  assert.equal(dedupe(noSel).length, 3);
});

test('dedupe keeps the worst severity and the best confidence', () => {
  const out = dedupe([
    { pageUrl: 'p', domSelector: '#x', wcagCriterion: '1.4.3', source: 'lighthouse', severity: 'moderate', confidence: 1, sources: ['lighthouse'] },
    { pageUrl: 'p', domSelector: '#x', wcagCriterion: '1.4.3', source: 'axe', severity: 'critical', confidence: 0.5, sources: ['axe'] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.equal(out[0].confidence, 1);
  assert.equal(maxSeverity('minor', 'serious'), 'serious');
});

test('fromA11yTree flags unnamed interactive nodes and a missing main landmark', () => {
  const tree = { role: 'WebArea', name: 'p', children: [{ role: 'button', name: '  ' }, { role: 'link', name: 'Home' }] };
  const out = fromA11yTree(tree, ctx);
  assert.equal(out.filter((f) => f.ruleId === 'tree-interactive-no-name').length, 1);
  assert.equal(out.filter((f) => f.ruleId === 'tree-no-main-landmark').length, 1);
  assert.equal(fromA11yTree({ role: 'main', children: [] }, ctx).length, 0);
});

test('unnamed tree nodes collapse into one counted summary, not one each', () => {
  // Tree findings carry no selector, so dedupe cannot merge them with axe's
  // per-element button-name. 84 unnamed buttons must not mean 84 extra findings.
  const many = { role: 'WebArea', children: Array.from({ length: 84 }, () => ({ role: 'button', name: '' })) };
  const out = fromA11yTree(many, { ...ctx }).filter((f) => f.ruleId === 'tree-interactive-no-name');
  assert.equal(out.length, 1);
  assert.equal(out[0].raw.count, 84);
  assert.deepEqual(out[0].raw.roles, { button: 84 });
  assert.match(out[0].description, /84 interactive node/);
  assert.ok(out[0].raw.examples.length <= 10, 'keeps a sample, not all 84');
});

test('findings that share a fingerprint still get unique ids (no silent DB overwrite)', () => {
  // Two axe nodes with the same target produce the same fingerprint; the ids
  // must still differ or one silently overwrites the other on insert.
  const twice = {
    violations: [{
      id: 'button-name', impact: 'serious', tags: ['wcag412', 'wcag2a'], help: 'Buttons need a name', helpUrl: 'https://x',
      nodes: [{ target: ['#b'], html: '<button id="b"></button>' }, { target: ['#b'], html: '<button id="b"></button>' }],
    }],
  };
  const out = fromAxe(twice, { ...ctx });
  assert.equal(out.length, 2);
  assert.equal(out[0].fingerprint, out[1].fingerprint);
  assert.notEqual(out[0].id, out[1].id);
});

test('fromKeyboard flags backwards tab order and invisible focus', () => {
  const trace = [
    { selector: 'a', domIndex: 0, outline: 'solid 2px rgb(0,0,0)', boxShadow: 'none', html: '<a/>' },
    { selector: 'b', domIndex: 5, outline: 'none 0px rgb(0,0,0)', boxShadow: 'none', html: '<b/>' },
    { selector: 'c', domIndex: 2, outline: 'solid 2px rgb(0,0,0)', boxShadow: 'none', html: '<c/>' },
  ];
  const out = fromKeyboard(trace, ctx);
  assert.deepEqual(out.map((f) => f.ruleId), ['focus-not-visible', 'focus-order-mismatch']);
  assert.equal(out.find((f) => f.ruleId === 'focus-not-visible').confidence, 0.9);
  assert.equal(noVisibleFocus({ outline: 'none 0px x', boxShadow: 'rgb(0,0,0) 0 0 3px' }), false);
});

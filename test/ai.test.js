import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, assessPage } from '../src/ai/tasks.js';
import { generateFixes } from '../src/ai/remediate.js';
import { groupComponents, bySeverity, deterministicOnly } from '../src/scan/group.js';
import { chunkMarkdown, criteriaCatalogue } from '../src/ai/knowledge.js';
import { toGeminiSchema, checkPerRunCap } from '../src/ai/gemini.js';

/** Stub model: records prompts, replies with whatever the test tells it to. */
const stubGemini = (reply) => {
  const seen = [];
  return {
    available: true,
    model: 'stub',
    seen,
    generate: async ({ task, prompt, schema, images }) => {
      seen.push({ task, prompt, schema, images });
      return { data: typeof reply === 'function' ? reply(task, prompt) : reply, cached: false };
    },
  };
};

const kb = {
  chunks: [],
  criterion: (n) => ({ id: n, file: 'wcag/criteria.md', heading: `${n} Test`, text: `guidance for ${n}` }),
  search: async () => [],
};

const inventory = {
  pageUrl: 'https://a.com/p',
  title: 'Test page',
  images: [{ selector: 'img#a', alt: 'logo.png', linked: true, context: 'Home', html: '<img id="a">' }],
  links: [{ selector: 'a#b', text: 'click here', href: '/x', context: 'more', html: '<a id="b">' }],
  headings: [{ selector: 'h1', level: 1, text: 'Welcome' }, { selector: 'h2', level: 2, text: 'More' }],
  fields: [{ selector: 'input#c', type: 'text', label: null, placeholder: 'Email', required: true, html: '<input id="c">' }],
  blocks: [],
};

test('assessPage maps model verdicts onto Findings and caps AI confidence below 1.0', async () => {
  const gemini = stubGemini({ findings: [{ index: 0, issue: 'alt is a filename', severity: 'serious', suggestion: 'Acme logo', confidence: 1.0 }] });
  const { findings, errors } = await assessPage({
    gemini, kb, inventory, ctx: { runId: 'r1', pageUrl: inventory.pageUrl, screenshotDir: 'runs/x' },
  });
  assert.equal(errors.length, 0);
  const alt = findings.find((f) => f.ruleId === 'ai-alt-text-quality');
  assert.equal(alt.source, 'ai');
  assert.equal(alt.wcagCriterion, '1.1.1');
  assert.equal(alt.domSelector, 'img#a');
  assert.equal(alt.suggestion, 'Acme logo');
  assert.equal(alt.needsReview, true);
  assert.ok(alt.confidence < 1, 'AI findings must never claim deterministic certainty');
  assert.ok(findings.every((f) => f.confidence <= 0.95));
});

test('assessPage drops hallucinated indexes instead of guessing an element', async () => {
  const gemini = stubGemini({ findings: [{ index: 99, issue: 'x', severity: 'minor', suggestion: 'y', confidence: 0.9 }] });
  const { findings } = await assessPage({ gemini, kb, inventory, ctx: { runId: 'r1', pageUrl: 'p', screenshotDir: 'runs/x' } });
  assert.equal(findings.length, 0);
});

test('assessPage escalates task errors rather than swallowing candidates', async () => {
  const gemini = { available: true, model: 'stub', generate: async () => { throw new Error('429 quota'); } };
  const { findings, errors } = await assessPage({ gemini, kb, inventory, ctx: { runId: 'r1', pageUrl: 'p', screenshotDir: 'runs/x' } });
  assert.equal(findings.length, 0);
  assert.ok(errors.length >= 1);
  assert.match(errors[0].message, /429/);
});

test('every task prompt carries its grounding block and the batch it judges', async () => {
  const gemini = stubGemini({ findings: [] });
  await assessPage({ gemini, kb, inventory, ctx: { runId: 'r1', pageUrl: 'p', screenshotDir: 'runs/x' } });
  assert.ok(gemini.seen.length >= 4, 'alt/link/heading/form tasks should all fire');
  for (const call of gemini.seen) {
    assert.match(call.prompt, /Grounding: WCAG guidance/);
    assert.ok(call.schema, 'every call must declare a response schema');
  }
});

test('reading-order only calls the model when visual order actually diverges', async () => {
  const task = TASKS.find((t) => t.name === 'reading-order');
  const inOrder = { blocks: [{ domIndex: 0, y: 0, x: 0 }, { domIndex: 1, y: 50, x: 0 }, { domIndex: 2, y: 100, x: 0 }] };
  assert.equal(task.select(inOrder).length, 0, 'no divergence, no API call');
  const scrambled = { blocks: [{ domIndex: 9, y: 0, x: 0 }, { domIndex: 0, y: 50, x: 0 }, { domIndex: 5, y: 100, x: 0 }] };
  assert.ok(task.select(scrambled).length > 0);
});

test('generateFixes keeps only fixes that map to a real finding in the group', async () => {
  const group = {
    pageUrl: 'https://a.com/p',
    component: 'div#main',
    findings: [
      { id: 'f1', wcagCriterion: '1.1.1', wcagLevel: 'A', severity: 'serious', ruleId: 'image-alt', description: 'missing alt', htmlSnippet: '<img src="x.png">', domSelector: 'img#a' },
    ],
  };
  const gemini = stubGemini({
    fixes: [
      { findingId: 'f1', after: '<img src="x.png" alt="Acme logo">', explanation: 'names the image', confidence: 1 },
      { findingId: 'ghost', after: '<b>nope</b>', explanation: 'hallucinated', confidence: 1 },
    ],
  });
  const fixes = await generateFixes({ gemini, kb, group });
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].findingId, 'f1');
  assert.equal(fixes[0].selector, 'img#a');
  assert.ok(fixes[0].confidence <= 0.95);
});

test('generateFixes feeds the verification failure back into the retry prompt', async () => {
  const group = { pageUrl: 'p', component: 'c', findings: [{ id: 'f1', ruleId: 'r', description: 'd', htmlSnippet: '<b>', domSelector: 'b' }] };
  const gemini = stubGemini({ fixes: [] });
  await generateFixes({ gemini, kb, group, failureReason: 'regressed: introduced color-contrast', attempt: 1 });
  assert.match(gemini.seen[0].prompt, /FAILED verification/);
  assert.match(gemini.seen[0].prompt, /introduced color-contrast/);
});

test('groupComponents chunks deterministically by DOM ancestry, worst first', () => {
  const f = (id, sel, sev) => ({ id, pageUrl: 'p', domSelector: sel, severity: sev, ruleId: 'r' });
  const groups = groupComponents(
    [f(1, 'div#a > ul > li', 'minor'), f(2, 'div#a > ul > a', 'critical'), f(3, 'div#b > p', 'moderate')],
    { depth: 2 }
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].component, 'div#a > ul');
  assert.equal(groups[0].findings.length, 2);
  assert.equal(groups.at(-1).component, 'div#b > p');
});

test('groupComponents batches flat axe selectors by rule instead of one group each', () => {
  // axe emits `img[src$="a.gif"]` with no ancestry on table-layout pages —
  // grouping by "ancestry" there would mean one API call per finding.
  const flat = Array.from({ length: 6 }, (_, i) => ({
    id: i, pageUrl: 'p', domSelector: `img[src$="pic${i}.gif"]`, severity: 'critical', ruleId: 'image-alt',
  }));
  const groups = groupComponents(flat, { depth: 2, maxPerGroup: 12 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].component, 'rule:image-alt');
  assert.equal(groups[0].findings.length, 6);
});

test('groupComponents splits oversized groups instead of one giant prompt', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i, pageUrl: 'p', domSelector: 'div#a > ul > li', severity: 'minor' }));
  const groups = groupComponents(many, { depth: 2, maxPerGroup: 10 });
  assert.deepEqual(groups.map((g) => g.findings.length), [10, 10, 5]);
});

test('deterministic filters replace vector search over findings', () => {
  const list = [
    { source: 'axe', severity: 'critical' },
    { source: 'ai', severity: 'minor' },
    { source: 'lighthouse', severity: 'moderate' },
  ];
  assert.equal(deterministicOnly(list).length, 2);
  assert.equal(bySeverity(list, 'moderate').length, 2);
});

test('knowledge chunking keeps criterion numbers addressable for exact lookup', () => {
  const chunks = chunkMarkdown('## 1.4.3 Contrast (Minimum) — Level AA\nratio 4.5\n\n## 2.4.7 Focus Visible — Level AA\noutline\n', 'wcag/criteria.md');
  assert.deepEqual(chunks.map((c) => c.criterion), ['1.4.3', '2.4.7']);
  const cat = criteriaCatalogue({ chunks });
  assert.deepEqual(cat, [
    { number: '1.4.3', name: 'Contrast (Minimum)', level: 'AA' },
    { number: '2.4.7', name: 'Focus Visible', level: 'AA' },
  ]);
});

test('checkPerRunCap stops a runaway loop from burning unbounded real calls', () => {
  assert.doesNotThrow(() => checkPerRunCap(0, 300));
  assert.doesNotThrow(() => checkPerRunCap(299, 300));
  assert.throws(() => checkPerRunCap(300, 300), /per-run cap reached \(300 requests this run\)/);
  assert.doesNotThrow(() => checkPerRunCap(1e6, Infinity), 'no config value means no cap');
});

test('toGeminiSchema marks enums the way the API requires', () => {
  const g = toGeminiSchema({ type: 'object', properties: { v: { type: 'string', enum: ['a', 'b'] } }, required: ['v'] });
  assert.equal(g.properties.v.format, 'enum');
  assert.deepEqual(g.required, ['v']);
});

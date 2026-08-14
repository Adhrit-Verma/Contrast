// The five Gemini judgment tasks. Each is a self-contained spec: what it picks
// out of the page (deterministically), what it asks, what schema comes back.
// The model only ever judges — it never decides what to look at.
import { retrieveGuidance, guidanceText } from './knowledge.js';
import { screenshotElement, slug } from '../scan/collect.js';
import { createHash } from 'node:crypto';

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const ISSUE_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'issue', 'severity', 'suggestion', 'confidence'],
        properties: {
          index: { type: 'integer', description: 'index of the item in the numbered list' },
          issue: { type: 'string', description: 'what is wrong, one sentence, concrete' },
          severity: { type: 'string', enum: ['critical', 'serious', 'moderate', 'minor'] },
          suggestion: { type: 'string', description: 'the corrected text or attribute value' },
          confidence: { type: 'number', description: '0-1, how sure you are this is a real problem' },
        },
      },
    },
  },
};

const RULES = `You are assisting a professional accessibility auditor. Rules:
- Report ONLY items that are genuinely problematic. An empty findings array is a correct answer.
- Never report an item just to have something to say.
- Judge the item in the context given, not in the abstract.
- "suggestion" must be the actual replacement text/attribute, not advice about how to write one.`;

const numbered = (items, render) => items.map((it, i) => `${i}. ${render(it)}`).join('\n');

export const TASKS = [
  {
    name: 'alt-text-quality',
    wcag: '1.1.1',
    level: 'A',
    ruleId: 'ai-alt-text-quality',
    batchSize: 8,
    needsImages: true,
    // Missing alt is axe's job. The gap is alt text that exists and is useless.
    select: (inv) => inv.images.filter((i) => (i.alt ?? i.ariaLabel ?? '').trim() !== '' || (i.alt === '' && i.linked)),
    prompt: (batch) =>
      `${RULES}

Task: judge whether each image's alternative text conveys what a sighted user gets from the image, in this page context.
Flag: filenames as alt ("logo.png"), redundant prefixes ("image of"), text that repeats adjacent visible text verbatim, alt="" on a LINKED image (the link then has no name), alt that describes the wrong thing, or alt that omits information the image actually carries (numbers in a chart, text baked into a banner).
Do NOT flag: correct concise alt, or genuinely decorative images with alt="".

Screenshots of the images follow in the same order as the list.

${numbered(batch, (i) => `alt=${JSON.stringify(i.alt)} aria-label=${JSON.stringify(i.ariaLabel ?? null)} linked=${i.linked} src=${i.src ?? 'n/a'}\n   nearby text: ${JSON.stringify(i.context)}`)}`,
  },

  {
    name: 'link-text-quality',
    wcag: '2.4.4',
    level: 'A',
    ruleId: 'ai-link-text-quality',
    batchSize: 40,
    select: (inv) => inv.links.filter((l) => (l.text || l.ariaLabel || '').trim().length > 0),
    prompt: (batch) =>
      `${RULES}

Task: judge whether each link/button name describes its destination or action when read on its own, out of context (as a screen reader user hears it in a links list).
Flag: "click here", "read more", "learn more", "here", "this", ">>", bare URLs, "download" with no object, duplicate names going to different destinations, and names that contradict the destination.
Do NOT flag: short but specific names ("Cart", "Home"), or names made clear by an aria-label.

${numbered(batch, (l) => `name=${JSON.stringify(l.ariaLabel || l.text)} href=${JSON.stringify(l.href)}\n   context: ${JSON.stringify(l.context)}`)}`,
  },

  {
    name: 'heading-semantics',
    wcag: '1.3.1',
    level: 'A',
    ruleId: 'ai-heading-semantics',
    batchSize: 60,
    select: (inv) => (inv.headings.length > 1 ? inv.headings : []),
    prompt: (batch, ctx) =>
      `${RULES}

Task: judge whether this heading outline describes the page's actual structure. Level skips are already caught by automated rules — do not repeat them unless the skip also breaks the meaning.
Flag: headings whose text does not describe the content beneath it, headings used for visual size only, a heading level that misrepresents nesting (a sibling section marked as a child), missing top-level heading for the page's subject, or generic headings ("Section", "More") that carry no information.

Page title: ${JSON.stringify(ctx.title)}

${numbered(batch, (h) => `h${h.level}: ${JSON.stringify(h.text)}`)}`,
  },

  {
    name: 'form-quality',
    wcag: '3.3.2',
    level: 'A',
    ruleId: 'ai-form-quality',
    batchSize: 30,
    select: (inv) => inv.fields,
    prompt: (batch) =>
      `${RULES}

Task: judge label and help/error text quality for each form field.
Flag: placeholder used as the only label, a label that does not say what to enter, required fields with no indication in the accessible name or description, format constraints not stated before entry ("MM/YYYY", "8+ characters"), error/help text that only says "invalid" without saying how to fix it, and labels that do not match the field type.
Do NOT flag: a missing <label> element when an aria-label already names the field (that is a different, automated rule).

${numbered(batch, (f) => `type=${f.type} required=${f.required} label=${JSON.stringify(f.label)} aria-label=${JSON.stringify(f.ariaLabel)} placeholder=${JSON.stringify(f.placeholder)} description=${JSON.stringify(f.describedByText)}`)}`,
  },

  {
    name: 'reading-order',
    wcag: '1.3.2',
    level: 'A',
    ruleId: 'ai-reading-order',
    batchSize: 60,
    // Deterministic pre-filter: only ask when visual order actually diverges
    // from DOM order. No mismatch, no call.
    select: (inv) => {
      const visual = [...inv.blocks].sort((a, b) => (Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x));
      const diverges = visual.some((b, i) => Math.abs(b.domIndex - i) > 2);
      return diverges ? visual.map((b, i) => ({ ...b, visualIndex: i })) : [];
    },
    prompt: (batch) =>
      `${RULES}

Task: a screen reader follows DOM order; a sighted user follows visual position. Below, blocks are listed in VISUAL order with their DOM index. Judge whether the difference changes the meaning or makes the content confusing when read in DOM order.
Flag: content that reads out of sequence (an answer before its question, a caption before what it captions, a sidebar interrupting an article, a form's submit before its fields).
Do NOT flag: harmless differences such as multi-column navigation or decorative blocks.

${numbered(batch, (b) => `visual#${b.visualIndex} dom#${b.domIndex} at (${b.x},${b.y}): ${JSON.stringify(b.text)}`)}`,
  },
];

/**
 * Run the enabled judgment tasks over one page's inventory.
 * @returns {Promise<{findings: object[], errors: {task: string, message: string}[]}>}
 */
export async function assessPage({ gemini, kb, page = null, inventory, ctx, cfg = {} }) {
  const findings = [];
  const errors = [];
  const enabled = cfg.tasks ?? {};

  for (const task of TASKS) {
    if (enabled[task.name] === false) continue;
    // Detected capability gates the feature: a model that cannot take an image
    // cannot judge alt text, and pretending otherwise would produce confident
    // nonsense about images it never saw.
    if (task.needsImages && cfg.capabilities && cfg.capabilities.vision === false) {
      errors.push({ task: task.name, message: 'skipped: the configured model has no vision support', items: 0 });
      continue;
    }
    const items = task.select(inventory);
    if (!items.length) continue;

    for (const batch of chunk(items, cfg.batchSize?.[task.name] ?? task.batchSize)) {
      try {
        const guidance = guidanceText(
          await retrieveGuidance(kb, { wcagCriterion: task.wcag, ruleId: task.ruleId, description: task.name }, 2)
        );
        const images = task.needsImages ? await shotsFor(page, batch, ctx) : [];
        const prompt = `${task.prompt(batch, { ...ctx, title: inventory.title })}

--- Grounding: WCAG guidance and house patterns (authoritative, prefer these) ---
${guidance || '(no knowledge base loaded)'}`;

        const { data, cached } = await gemini.generate({ task: task.name, prompt, schema: ISSUE_SCHEMA, images });
        for (const r of data.findings ?? []) {
          const item = batch[r.index];
          if (!item) continue; // model hallucinated an index — drop it, never guess
          findings.push(toFinding(task, item, r, ctx, cached));
        }
      } catch (err) {
        errors.push({ task: task.name, message: err.message, items: batch.length });
      }
    }
  }
  return { findings, errors };
}

/** Prefer shots captured during the scan; only go back to the page if we must. */
async function shotsFor(page, batch, ctx) {
  const out = [];
  for (const item of batch) {
    out.push(
      item.screenshotPath ??
        (page ? await screenshotElement(page, item.selector, ctx.screenshotDir, `${slug(ctx.pageUrl)}-ai-${slug(item.selector)}`) : null)
    );
  }
  return out.filter(Boolean);
}

function toFinding(task, item, r, ctx, cached) {
  const f = {
    runId: ctx.runId,
    pageUrl: ctx.pageUrl,
    timestamp: new Date().toISOString(),
    source: 'ai',
    wcagCriterion: task.wcag,
    wcagLevel: task.level,
    severity: r.severity ?? 'moderate',
    ruleId: task.ruleId,
    domSelector: item.selector ?? null,
    htmlSnippet: item.html ?? null,
    computedStyles: null,
    screenshotPath: null,
    description: r.issue,
    // Hard ceiling: an AI assessment is never as certain as a deterministic one.
    confidence: Math.min(0.95, Math.max(0.1, r.confidence ?? 0.6)),
    needsReview: true,
    suggestion: r.suggestion,
    sources: ['ai'],
    helpUrl: `https://www.w3.org/WAI/WCAG22/Understanding/${task.wcag}`,
    raw: { model: r, item, cached },
  };
  f.fingerprint = createHash('sha1').update([f.pageUrl, f.ruleId, f.domSelector, f.wcagCriterion].join('|')).digest('hex').slice(0, 16);
  f.id = createHash('sha1').update(`${f.runId}|${f.fingerprint}|ai|${r.index}`).digest('hex').slice(0, 20);
  return f;
}

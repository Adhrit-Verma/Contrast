// AI task 6: remediation generation. Grounded in the WCAG criterion + house
// patterns; output is a per-finding HTML replacement so Phase 5 can inject and
// re-scan it. Anything not verified stays labelled a suggestion.
import { retrieveGuidance, guidanceText } from './knowledge.js';

const FIX_SCHEMA = {
  type: 'object',
  required: ['fixes'],
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['findingId', 'after', 'explanation'],
        properties: {
          findingId: { type: 'string' },
          after: { type: 'string', description: 'the complete corrected outerHTML for that one element' },
          css: { type: 'string', description: 'extra CSS needed, or empty string', nullable: true },
          explanation: { type: 'string', description: 'why this resolves the criterion, one or two sentences' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const describe = (f) =>
  [
    `findingId: ${f.id}`,
    `wcag: ${f.wcagCriterion} (${f.wcagLevel}) via ${f.ruleId} [${f.severity}]`,
    `problem: ${f.description}`,
    f.suggestion ? `assessor suggestion: ${f.suggestion}` : null,
    f.computedStyles ? `computed: ${JSON.stringify(f.computedStyles)}` : null,
    f.raw?.failureSummary ? `tool detail: ${String(f.raw.failureSummary).replace(/\s+/g, ' ').slice(0, 300)}` : null,
    `current html:\n${f.htmlSnippet ?? '(not captured)'}`,
  ]
    .filter(Boolean)
    .join('\n');

/**
 * @param {{gemini: object, kb: object, group: object, failureReason?: string, attempt?: number}} args
 * @returns {Promise<object[]>} fixes: {findingId, before, after, css, explanation, confidence}
 */
export async function generateFixes({ gemini, kb, group, failureReason = null, attempt = 0 }) {
  const criteria = [...new Set(group.findings.map((f) => f.wcagCriterion).filter(Boolean))];
  const docs = [];
  for (const f of group.findings.slice(0, 4)) docs.push(...(await retrieveGuidance(kb, f, 1)));
  const guidance = guidanceText(dedupeDocs(docs));

  const prompt = `You are a senior accessibility engineer producing remediation code that will be automatically re-tested with axe-core.

Rules:
- Return corrected outerHTML for EACH findingId, complete and self-contained.
- Change the minimum needed to resolve the criterion. Preserve classes, ids, data-* attributes, event handler attributes, and visible text unless the finding is about that text.
- Do not invent content. If alt text or a label needs wording you cannot know, use the assessor suggestion, or wording derived from the surrounding context given below.
- Prefer native HTML semantics over ARIA. Only add ARIA when no native element does the job.
- If a fix genuinely requires CSS, put it in "css" as a rule using the element's existing selector.
- If you cannot fix an item safely, omit it from the array rather than guessing.

Page: ${group.pageUrl}
Component: ${group.component}
WCAG criteria in scope: ${criteria.join(', ') || 'n/a'}

--- Findings ---
${group.findings.map(describe).join('\n\n')}

--- Grounding: WCAG guidance and house patterns (authoritative, follow these) ---
${guidance || '(no knowledge base loaded)'}
${failureReason ? `\n--- Previous attempt ${attempt} FAILED verification ---\n${failureReason}\nProduce a different fix that addresses this. Do not repeat the previous output.` : ''}`;

  const { data } = await gemini.generate({ task: 'remediation', prompt, schema: FIX_SCHEMA, temperature: attempt ? 0.4 : 0.1 });

  const byId = new Map(group.findings.map((f) => [f.id, f]));
  return (data.fixes ?? [])
    .filter((fix) => byId.has(fix.findingId))
    .map((fix) => ({
      findingId: fix.findingId,
      before: byId.get(fix.findingId).htmlSnippet,
      after: fix.after,
      css: fix.css || null,
      explanation: fix.explanation,
      confidence: Math.min(0.95, fix.confidence ?? 0.6),
      selector: byId.get(fix.findingId).domSelector,
      finding: byId.get(fix.findingId),
    }));
}

const dedupeDocs = (docs) => {
  const seen = new Set();
  return docs.filter((d) => d && !seen.has(d.id) && seen.add(d.id));
};

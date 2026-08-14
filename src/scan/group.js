// Deterministic component grouping. NOT retrieval, NOT clustering — findings
// are complete and structured, so we chunk them by where they live in the DOM.
// One group = one Gemini fix call = one verification pass.

/**
 * axe often returns a flat selector with no descendant combinator
 * (`img[src$="logo.gif"]`). Grouping those by "ancestry" gives one group per
 * finding — 40 API calls where 4 would do. Fall back to the rule, which is the
 * real component boundary for that shape of finding.
 */
const componentKey = (finding, depth) => {
  const path = (finding.domSelector ?? '').split(' > ').filter(Boolean);
  return path.length > 1 ? path.slice(0, depth).join(' > ') : `rule:${finding.ruleId}`;
};

/**
 * @param {object[]} findings
 * @param {{depth?: number, maxPerGroup?: number}} opts
 * @returns {{key: string, pageUrl: string, component: string, findings: object[]}[]}
 */
export function groupComponents(findings, { depth = 2, maxPerGroup = 12 } = {}) {
  const buckets = new Map();
  for (const f of findings) {
    const component = componentKey(f, depth);
    const key = `${f.pageUrl}||${component}`;
    if (!buckets.has(key)) buckets.set(key, { key, pageUrl: f.pageUrl, component, findings: [] });
    buckets.get(key).findings.push(f);
  }
  // Split oversized groups so a single prompt never carries 200 findings.
  const groups = [];
  for (const g of buckets.values()) {
    for (let i = 0; i < g.findings.length; i += maxPerGroup) {
      const slice = g.findings.slice(i, i + maxPerGroup);
      groups.push({ ...g, key: i ? `${g.key}#${i / maxPerGroup}` : g.key, findings: slice });
    }
  }
  return groups.sort((a, b) => worst(b.findings) - worst(a.findings));
}

const RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 };
const worst = (findings) => Math.max(...findings.map((f) => RANK[f.severity] ?? 0));

/** Deterministic filters — use these instead of any vector search over findings. */
export const byPage = (findings, pageUrl) => findings.filter((f) => f.pageUrl === pageUrl);
export const byLevel = (findings, levels) => findings.filter((f) => levels.includes(f.wcagLevel));
export const bySeverity = (findings, min = 'moderate') =>
  findings.filter((f) => (RANK[f.severity] ?? 0) >= (RANK[min] ?? 0));
export const deterministicOnly = (findings) => findings.filter((f) => f.source !== 'ai');

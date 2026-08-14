// Tool output -> Finding[] -> deduped. Pure functions, no I/O: this is where
// silent bugs hide in a compliance tool, so it is the most-tested file here.
import { createHash } from 'node:crypto';

export const SOURCE_PRIORITY = ['axe', 'lighthouse', 'a11y-tree', 'keyboard', 'ai'];

/** axe tags -> WCAG criterion + level. "wcag111" => 1.1.1, "wcag21aa" => AA. */
export function wcagFromTags(tags = []) {
  let criterion = null;
  let level = null;
  for (const tag of tags) {
    const c = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    if (c && !criterion) criterion = `${c[1]}.${c[2]}.${c[3]}`;
    const l = /^wcag2[12]?(a{1,3})$/.exec(tag);
    if (l && !level) level = l[1].toUpperCase();
  }
  return { criterion, level };
}

export const fingerprint = (f) =>
  createHash('sha1').update([f.pageUrl, f.ruleId, f.domSelector, f.wcagCriterion].join('|')).digest('hex').slice(0, 16);

const targetToSelector = (target = []) => target.flat().join(' , ');

/** Only single-element string targets are usable with querySelector. */
export const isQueryable = (target = []) => Array.isArray(target) && target.length === 1 && typeof target[0] === 'string';

function make(ctx, fields) {
  const f = {
    runId: ctx.runId,
    pageUrl: ctx.pageUrl,
    timestamp: ctx.timestamp ?? new Date().toISOString(),
    wcagCriterion: null,
    wcagLevel: null,
    severity: 'moderate',
    computedStyles: null,
    screenshotPath: null,
    helpUrl: null,
    confidence: 1.0,
    sources: [fields.source],
    ...fields,
  };
  f.fingerprint = fingerprint(f);
  // Two findings can legitimately share a fingerprint (same rule, same null
  // selector, different node). An ordinal keeps the primary key unique so the
  // DB never silently swallows one — while staying stable across identical reruns.
  ctx.seq ??= new Map();
  const n = (ctx.seq.get(f.fingerprint) ?? 0) + 1;
  ctx.seq.set(f.fingerprint, n);
  f.id = createHash('sha1').update(`${ctx.runId}|${f.fingerprint}|${f.source}|${n}`).digest('hex').slice(0, 20);
  return f;
}

// -------------------------------------------------------------- axe

export function fromAxe(results, ctx) {
  const out = [];
  for (const v of results?.violations ?? []) {
    const { criterion, level } = wcagFromTags(v.tags);
    for (const node of v.nodes ?? []) {
      out.push(
        make(ctx, {
          source: 'axe',
          wcagCriterion: criterion,
          wcagLevel: level,
          severity: node.impact ?? v.impact ?? 'moderate',
          ruleId: v.id,
          domSelector: targetToSelector(node.target),
          htmlSnippet: node.html,
          description: v.help,
          helpUrl: v.helpUrl,
          confidence: 1.0,
          raw: { failureSummary: node.failureSummary, target: node.target, data: node.any?.[0]?.data ?? null },
        })
      );
    }
  }
  // "incomplete" = axe could not decide. Real audit fodder, but never certain.
  for (const v of results?.incomplete ?? []) {
    const { criterion, level } = wcagFromTags(v.tags);
    for (const node of v.nodes ?? []) {
      out.push(
        make(ctx, {
          source: 'axe',
          wcagCriterion: criterion,
          wcagLevel: level,
          severity: 'moderate',
          ruleId: `${v.id}:incomplete`,
          domSelector: targetToSelector(node.target),
          htmlSnippet: node.html,
          description: `Needs human review: ${v.help}`,
          helpUrl: v.helpUrl,
          confidence: 0.5,
          needsReview: true,
          raw: { failureSummary: node.failureSummary, target: node.target },
        })
      );
    }
  }
  return out;
}

// ------------------------------------------------------- lighthouse

/** ruleMeta comes from axe.getRules(); LH audit ids match axe rule ids. */
export function fromLighthouse(lh, ruleMeta = [], ctx) {
  const tagsById = new Map(ruleMeta.map((r) => [r.ruleId, r.tags]));
  const out = [];
  for (const audit of lh?.audits ?? []) {
    const { criterion, level } = wcagFromTags(tagsById.get(audit.id) ?? []);
    const items = audit.details?.items ?? [];
    const nodes = items.length ? items : [{ node: { selector: null, snippet: null } }];
    for (const item of nodes) {
      out.push(
        make(ctx, {
          source: 'lighthouse',
          wcagCriterion: criterion,
          wcagLevel: level,
          severity: audit.score === 0 ? 'serious' : 'moderate',
          ruleId: audit.id,
          domSelector: item.node?.selector ?? null,
          htmlSnippet: item.node?.snippet ?? null,
          description: audit.title,
          helpUrl: `https://dequeuniversity.com/rules/axe/latest/${audit.id}`,
          confidence: 1.0,
          raw: { explanation: item.node?.explanation ?? audit.description },
        })
      );
    }
  }
  return out;
}

// -------------------------------------------------------- a11y tree

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch', 'slider']);

export function fromA11yTree(tree, ctx) {
  const out = [];
  if (!tree) return out;
  const roles = new Set();
  const unnamed = [];
  const walk = (node) => {
    if (!node) return;
    roles.add(node.role);
    if (INTERACTIVE_ROLES.has(node.role) && !node.name?.trim() && !node.disabled) unnamed.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(tree);

  // One summary, not one finding per node. Tree nodes carry no DOM selector, so
  // dedupe cannot merge them with axe's button-name/link-name — which meant a
  // page with 84 unnamed buttons produced 84 axe findings AND 84 identical tree
  // findings. The count is the signal; the individual nodes are already axe's.
  if (unnamed.length) {
    const roleCounts = unnamed.reduce((acc, n) => ((acc[n.role] = (acc[n.role] ?? 0) + 1), acc), {});
    out.push(
      make(ctx, {
        source: 'a11y-tree',
        wcagCriterion: '4.1.2',
        wcagLevel: 'A',
        severity: 'serious',
        ruleId: 'tree-interactive-no-name',
        domSelector: null,
        htmlSnippet: null,
        description:
          `${unnamed.length} interactive node(s) reach assistive technology with no accessible name ` +
          `(${Object.entries(roleCounts).map(([r, n]) => `${n} ${r}`).join(', ')}). ` +
          'Cross-check against the per-element findings from axe.',
        confidence: 1.0,
        raw: { count: unnamed.length, roles: roleCounts, examples: unnamed.slice(0, 10) },
      })
    );
  }

  if (!roles.has('main')) {
    out.push(
      make(ctx, {
        source: 'a11y-tree',
        wcagCriterion: '1.3.1',
        wcagLevel: 'A',
        severity: 'moderate',
        ruleId: 'tree-no-main-landmark',
        domSelector: null,
        htmlSnippet: null,
        description: 'No main landmark in the accessibility tree — screen reader users cannot skip to content',
        confidence: 1.0,
        raw: null,
      })
    );
  }
  return out;
}

// --------------------------------------------------------- keyboard

// "outline: <style> <width> <color>" as captured by collect.js.
// ponytail: only detects outline/box-shadow indicators. A focus style done with
// background-color or border will read as a false positive — hence confidence
// 0.9 + needsReview rather than a hard 1.0 claim.
export function noVisibleFocus(step) {
  const [style, width] = (step.outline ?? '').split(' ');
  const hasOutline = style && style !== 'none' && width !== '0px';
  const hasShadow = step.boxShadow && step.boxShadow !== 'none';
  return !hasOutline && !hasShadow;
}

export function fromKeyboard(trace = [], ctx) {
  const out = [];
  let prevDom = -1;
  for (const [i, step] of trace.entries()) {
    if (step.domIndex > -1 && step.domIndex < prevDom) {
      out.push(
        make(ctx, {
          source: 'keyboard',
          wcagCriterion: '2.4.3',
          wcagLevel: 'A',
          severity: 'serious',
          ruleId: 'focus-order-mismatch',
          domSelector: step.selector,
          htmlSnippet: step.html,
          description: `Tab stop ${i + 1} goes backwards in DOM order (DOM index ${step.domIndex} after ${prevDom}) — likely a positive tabindex or reordered layout`,
          confidence: 1.0,
          raw: step,
        })
      );
    }
    prevDom = Math.max(prevDom, step.domIndex);

    if (noVisibleFocus(step)) {
      out.push(
        make(ctx, {
          source: 'keyboard',
          wcagCriterion: '2.4.7',
          wcagLevel: 'AA',
          severity: 'serious',
          ruleId: 'focus-not-visible',
          domSelector: step.selector,
          htmlSnippet: step.html,
          computedStyles: { outline: step.outline, 'box-shadow': step.boxShadow },
          description: 'Element receives keyboard focus with no outline and no box-shadow — likely no visible focus indicator',
          confidence: 0.9,
          needsReview: true,
          raw: step,
        })
      );
    }
  }
  return out;
}

// ----------------------------------------------------------- dedupe

/**
 * Axe and Lighthouse overlap heavily. Collapse by (page + selector + criterion),
 * keeping the highest-priority source and recording the others. Findings with no
 * selector or no criterion are NEVER merged — we cannot prove they are the same
 * issue, and dropping a real finding is worse than showing it twice.
 */
export function dedupe(findings) {
  const slotByKey = new Map(); // key -> index into kept
  const kept = [];
  for (const f of findings) {
    if (!f.domSelector || !f.wcagCriterion) {
      kept.push(f);
      continue;
    }
    const key = `${f.pageUrl}|${f.domSelector}|${f.wcagCriterion}`;
    const slot = slotByKey.get(key);
    if (slot === undefined) {
      slotByKey.set(key, kept.push(f) - 1);
      continue;
    }
    const existing = kept[slot];
    const better = SOURCE_PRIORITY.indexOf(f.source) < SOURCE_PRIORITY.indexOf(existing.source);
    const winner = better ? f : existing;
    winner.sources = [...new Set([...(existing.sources ?? []), ...(f.sources ?? [])])];
    winner.severity = maxSeverity(existing.severity, f.severity);
    winner.confidence = Math.max(existing.confidence ?? 1, f.confidence ?? 1);
    kept[slot] = winner;
  }
  return kept;
}

const SEVERITY_ORDER = ['minor', 'moderate', 'serious', 'critical'];
export const maxSeverity = (a, b) =>
  SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;

export function normalize({ axe, lighthouse, tree, keyboard }, ctx) {
  return dedupe([
    ...fromAxe(axe, ctx),
    ...fromLighthouse(lighthouse, axe?.ruleMeta ?? [], ctx),
    ...fromA11yTree(tree, ctx),
    ...fromKeyboard(keyboard, ctx),
  ]);
}

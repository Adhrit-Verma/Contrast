// Phase 5: a fix that is not verified is a suggestion. This is what tells the
// difference. Fresh page, baseline scan, inject, rescan, compare.
import { runAxe } from '../scan/collect.js';

const nodeKeys = (results) => {
  const keys = new Set();
  for (const v of results?.violations ?? []) {
    for (const n of v.nodes ?? []) keys.add(`${v.id}|${n.target.flat().join(' ')}`);
  }
  return keys;
};

const ruleKeys = (results) => new Set((results?.violations ?? []).map((v) => v.id));

/**
 * @param {{newPage: () => Promise<import('puppeteer').Page>}} ctx
 * @param {{selector: string, after: string, css?: string, finding: object}} fix
 * @returns {Promise<{status:'verified'|'unresolved'|'regressed'|'error', notes:string, regressions:string[]}>}
 */
export async function verifyFix(ctx, fix, { navTimeoutMs = 30000 } = {}) {
  const finding = fix.finding;
  if (!fix.selector || fix.selector.includes(' , ')) {
    return { status: 'error', notes: 'no single-element selector to inject into', regressions: [] };
  }
  // Alt-text wording, link text quality, reading order: axe cannot decide these,
  // so re-running it proves nothing. Say "unverified" rather than looping three
  // times and then calling a perfectly good suggestion a failure.
  if (!isAxeVerifiable(finding)) {
    return {
      status: 'unverified',
      notes: `${finding.source} finding (${finding.ruleId}) is a judgment call — axe cannot confirm it. Needs auditor review.`,
      regressions: [],
    };
  }
  const page = await ctx.newPage();
  try {
    await page.goto(finding.pageUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    const before = await runAxe(page);

    const injected = await page.evaluate(
      (selector, html, css) => {
        const el = document.querySelector(selector);
        if (!el) return 'selector no longer matches';
        try {
          el.outerHTML = html;
        } catch (err) {
          return `outerHTML assignment failed: ${err.message}`;
        }
        if (css) {
          const style = document.createElement('style');
          style.setAttribute('data-a11y-fix', '1');
          style.textContent = css;
          document.head.appendChild(style);
        }
        return null;
      },
      fix.selector,
      fix.after,
      fix.css ?? null
    );
    if (injected) return { status: 'error', notes: injected, regressions: [] };

    const after = await runAxe(page);
    const beforeKeys = nodeKeys(before);
    const afterKeys = nodeKeys(after);

    // Did the specific violation go away? Match on rule + selector when we have
    // both; fall back to "this rule no longer fires anywhere on the page".
    const targetKey = `${baseRule(finding.ruleId)}|${finding.raw?.target?.flat?.().join(' ') ?? finding.domSelector}`;
    const resolved = beforeKeys.has(targetKey)
      ? !afterKeys.has(targetKey)
      : ruleKeys(before).has(baseRule(finding.ruleId)) && !ruleKeys(after).has(baseRule(finding.ruleId));

    const regressions = [...afterKeys].filter((k) => !beforeKeys.has(k));

    if (regressions.length) {
      return {
        status: 'regressed',
        notes: `fix introduced ${regressions.length} new violation(s): ${regressions.slice(0, 5).join(', ')}`,
        regressions,
      };
    }
    if (!resolved) {
      return {
        status: 'unresolved',
        notes: `axe still reports ${baseRule(finding.ruleId)} after the fix`,
        regressions: [],
      };
    }
    return {
      status: 'verified',
      notes: `${baseRule(finding.ruleId)} resolved, ${beforeKeys.size} -> ${afterKeys.size} violations page-wide`,
      regressions: [],
    };
  } catch (err) {
    return { status: 'error', notes: err.message, regressions: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

// AI and keyboard findings have no axe rule to re-check; strip our suffixes.
const baseRule = (ruleId) => String(ruleId ?? '').replace(/:incomplete$/, '');

/** AI/keyboard findings cannot be proven by axe — say so instead of pretending. */
export const isAxeVerifiable = (finding) =>
  finding.source === 'axe' || finding.source === 'lighthouse';

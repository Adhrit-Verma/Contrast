// The "self-analysis" ledger: plain, inspectable pattern matching promoted by
// a human from a real scan_incidents row (src/db.js's insertRule/listRules) —
// never inferred automatically. Kept explicit on purpose, same reasoning as
// this codebase's MEASURED-vs-AI-ASSESSED split: a rule is only as good as the
// human who wrote it, so it should read like one, not like a model's guess.
import { listRules } from '../db.js';

export const loadActiveRules = (db) => listRules(db);

/** True if this page matches a rule whose action is 'treat_as_blocked' — the
 *  only action v1 supports. `page` is { url, title, status }. */
export function matchesRule(rules, page) {
  return rules.some((r) => {
    if (r.action !== 'treat_as_blocked') return false;
    if (r.patternType === 'domain') {
      try { return new URL(page.url).hostname.includes(r.pattern); } catch { return false; }
    }
    if (r.patternType === 'content') {
      return `${page.title ?? ''} ${page.url ?? ''}`.toLowerCase().includes(r.pattern.toLowerCase());
    }
    return false;
  });
}

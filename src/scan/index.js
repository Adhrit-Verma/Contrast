import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  runAxe, axeRuleMeta, runLighthouse, a11yTree, keyboardTrace, pageInventory,
  computedStylesFor, screenshotPage, screenshotElement, slug,
} from './collect.js';
import { normalize, isQueryable } from './normalize.js';
import { withTimeout } from '../timeout.js';
import { insert, insertFindings } from '../db.js';

export const runDir = (runId) => join('runs', runId);

export function startRun(db, client) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  insert(db, 'runs', {
    id: runId, clientId: client.id, seedUrl: client.seedUrl,
    startedAt: new Date().toISOString(), finishedAt: null, config: client, notes: null,
  });
  return runId;
}

export const finishRun = (db, runId) =>
  db.prepare('UPDATE runs SET finishedAt = ? WHERE id = ?').run(new Date().toISOString(), runId);

/**
 * Everything Phase 2 collects for one loaded page: deterministic findings plus
 * the inventory the Phase 3 judgment tasks will need later (the page is gone by
 * then, so anything the AI has to look at is captured here).
 * @returns {Promise<{findings: object[], inventory: object}>}
 */
export async function scanPage(page, pageInfo, { runId, client, db, persist = true }) {
  const cfg = client.scan ?? {};
  const pageUrl = pageInfo.finalUrl ?? pageInfo.url;
  const dir = join(runDir(runId), 'screenshots');
  const ctx = { runId, pageUrl, timestamp: new Date().toISOString() };

  // Per-stage timings: without these, "the audit is stuck" is unanswerable.
  const timings = {};
  const timed = async (name, work) => {
    const t0 = Date.now();
    try {
      return await work();
    } finally {
      timings[name] = Date.now() - t0;
    }
  };

  const axe = await timed('axe', () =>
    withTimeout(runAxe(page), cfg.axeTimeoutMs ?? 60000, `axe on ${pageUrl}`)
  ).catch((err) => {
    // Never fail silently: a swallowed axe error looks identical to a clean page.
    console.error(`    !! axe failed on ${pageUrl}: ${err.message}`);
    return { violations: [], incomplete: [], ruleMeta: axeRuleMeta(), error: err.message };
  });
  const tree = cfg.a11yTree === false ? null : await timed('tree', () => a11yTree(page, cfg.a11yTreeInterestingOnly !== false));
  const keyboard = cfg.keyboard === false
    ? []
    : await timed('keyboard', () => keyboardTrace(page, cfg.maxTabs ?? 40, cfg.keyboardTimeoutMs ?? 20000)).catch(() => []);

  let lighthouse = { audits: [] };
  if (cfg.lighthouse) {
    // 25–45s of total silence otherwise, which reads as a hang.
    console.log('    lighthouse…');
    lighthouse = await timed('lighthouse', () => runLighthouse(page, pageUrl, cfg.lighthouseOptions ?? {})).catch((err) => {
      console.log(`  lighthouse failed on ${pageUrl}: ${err.message}`);
      return { audits: [], error: err.message };
    });
    // Lighthouse drives its own navigation; get the DOM back before enriching.
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }

  const findings = normalize({ axe, lighthouse, tree, keyboard }, ctx);

  // Enrich only what we can address in the DOM. Every element screenshot is a
  // CDP round trip, so this gets a wall-clock budget as well as a count — on a
  // page with 300 findings it was the slowest thing in the whole audit.
  await timed('enrich', async () => {
    let shots = 0;
    const deadline = Date.now() + (cfg.enrichBudgetMs ?? 45000);
    for (const f of findings) {
      const target = f.raw?.target;
      const selector = isQueryable(target) ? target[0] : f.domSelector;
      if (!selector || selector.includes(' , ')) continue;
      if (Date.now() > deadline) {
        console.log(`    enrichment budget spent — ${shots} screenshots, remaining findings keep their tool data`);
        break;
      }
      f.computedStyles ??= await computedStylesFor(page, selector, f.ruleId);
      if (f.raw?.data) f.computedStyles = { ...f.computedStyles, ...contrastFacts(f.raw.data) };
      if (cfg.screenshots !== false && shots < (cfg.maxElementShots ?? 60)) {
        f.screenshotPath = await screenshotElement(page, selector, dir, `${slug(pageUrl)}-${f.id}`);
        if (f.screenshotPath) shots++;
      }
    }
  });

  const screenshotPath = cfg.screenshots === false ? null : await screenshotPage(page, dir, pageUrl);

  // AI candidates: collected deterministically now, judged later (batched and
  // rate-limited) when this page is no longer open.
  const inventory = cfg.inventory === false ? emptyInventory() : await pageInventory(page, cfg.inventoryLimits ?? {});
  inventory.pageUrl = pageUrl;
  if (cfg.screenshots !== false) {
    for (const img of (inventory.images ?? []).slice(0, cfg.maxImageShots ?? 12)) {
      img.screenshotPath = await screenshotElement(page, img.selector, dir, `${slug(pageUrl)}-img-${slug(img.selector)}`);
    }
  }

  if (persist) {
    // Inventory on disk so `assess` can run later (or again) without re-crawling.
    mkdirSync(join(runDir(runId), 'inventory'), { recursive: true });
    writeFileSync(join(runDir(runId), 'inventory', `${slug(pageUrl)}.json`), JSON.stringify(inventory));
    insert(db, 'pages', {
      runId, url: pageInfo.url, finalUrl: pageUrl, title: pageInfo.title ?? null,
      status: pageInfo.status ?? null, screenshotPath, a11yTree: tree, error: pageInfo.error ?? null,
    });
    insertFindings(db, findings);
  }
  const spent = Object.entries(timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(' · ');
  console.log(`    ${findings.length} findings (axe ${axe.violations?.length ?? 0} violations, keyboard ${keyboard.length} tab stops)`);
  console.log(`    time: ${spent}`);
  return { findings, inventory, timings };
}

const emptyInventory = () => ({ images: [], links: [], headings: [], fields: [], blocks: [] });

/** axe measures real rendered contrast — keep those numbers, not declared CSS. */
const contrastFacts = (data) =>
  data.contrastRatio == null
    ? {}
    : {
        contrastRatio: data.contrastRatio,
        expectedContrastRatio: data.expectedContrastRatio,
        fgColor: data.fgColor,
        bgColor: data.bgColor,
      };

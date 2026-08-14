// Phase 7: orchestration only. Puppeteer, axe and Lighthouse are called
// directly as the plain functions they are — no tool wrappers, no chains.
// LangGraph earns its place here for three things: the generateFix -> verifyFix
// -> retry cycle, SqliteSaver checkpointing across a long authenticated audit,
// and interrupt() making the auditor a node instead of an out-of-band process.
import { StateGraph, Annotation, START, END, interrupt } from '@langchain/langgraph';
import { crawl } from '../browser/crawl.js';
import { scanPage, startRun, finishRun, runDir } from '../scan/index.js';
import { dedupe } from '../scan/normalize.js';
import { groupComponents } from '../scan/group.js';
import { assessPage } from '../ai/tasks.js';
import { generateFixes } from '../ai/remediate.js';
import { retrieveGuidance, guidanceText, criteriaCatalogue } from '../ai/knowledge.js';
import { verifyFix } from '../verify/index.js';
import { insert, insertFindings } from '../db.js';
import { writeJson, writeHtml, writeVpat } from '../report/index.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const replace = (a, b) => (b === undefined ? a : b);
const append = (a, b) => [...(a ?? []), ...(Array.isArray(b) ? b : [b])];
/** Append, but idempotent on id — a resumed checkpoint must not double-count. */
const appendUnique = (a, b) => {
  const seen = new Set((a ?? []).map((x) => x.id));
  return [...(a ?? []), ...(Array.isArray(b) ? b : [b]).filter((x) => x && !seen.has(x.id) && seen.add(x.id))];
};

export const AuditState = Annotation.Root({
  runId: Annotation({ reducer: replace, default: () => null }),
  clientId: Annotation({ reducer: replace, default: () => null }),
  pagesQueued: Annotation({ reducer: replace, default: () => [] }),
  pagesScanned: Annotation({ reducer: append, default: () => [] }),
  findings: Annotation({ reducer: appendUnique, default: () => [] }),
  inventories: Annotation({ reducer: append, default: () => [] }),
  componentQueue: Annotation({ reducer: replace, default: () => [] }),
  currentComponent: Annotation({ reducer: replace, default: () => null }),
  guidance: Annotation({ reducer: replace, default: () => '' }),
  proposedFix: Annotation({ reducer: replace, default: () => null }),
  verificationResult: Annotation({ reducer: replace, default: () => null }),
  failureReason: Annotation({ reducer: replace, default: () => null }),
  fixAttempts: Annotation({ reducer: replace, default: () => 0 }),
  completedFixes: Annotation({ reducer: append, default: () => [] }),
  abandonedFindings: Annotation({ reducer: append, default: () => [] }),
  errors: Annotation({ reducer: append, default: () => [] }),
  reportPaths: Annotation({ reducer: replace, default: () => ({}) }),
});

/**
 * @param {{client, db, session, gemini, kb, log?}} deps  session = openSession() result
 */
export function buildAuditGraph(deps) {
  const { client, db, session, gemini, kb, log = console.log } = deps;
  const maxAttempts = client.graph?.maxFixAttempts ?? 3;

  const escalate = (runId, finding, reason, context) =>
    insert(db, 'review_queue', {
      id: randomUUID().slice(0, 18), runId, findingId: finding?.id ?? null,
      reason, context: JSON.stringify(context ?? {}), createdAt: new Date().toISOString(),
    });

  // ------------------------------------------------------------- nodes

  /** The auditor is a node: the graph pauses here and the CLI drives the login. */
  async function login(state) {
    if (client.requiresLogin === false || session.loggedIn) return {};
    if (client.graph?.interruptOnLogin !== false) {
      interrupt({ type: 'manual-login', clientId: client.id, seedUrl: client.seedUrl });
    }
    return {};
  }

  async function crawlNode(state) {
    const runId = state.runId ?? startRun(db, client);
    // ponytail: discovery and scanning are separate passes, so each page loads
    // twice. Bought deliberately — it makes the scan loop resumable from a
    // checkpoint, which matters far more on a 500-page authenticated audit.
    const pages = await crawl(session, client, async () => {});
    const urls = pages.filter((p) => !p.error).map((p) => p.finalUrl ?? p.url);
    log(`crawl: ${urls.length} pages in scope`);
    return { runId, clientId: client.id, pagesQueued: urls };
  }

  async function scanPageNode(state) {
    const [url, ...rest] = state.pagesQueued;
    const page = session.page;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const { findings, inventory } = await scanPage(
        page, { url, finalUrl: page.url(), title: await page.title() },
        { runId: state.runId, client, db, persist: false }
      );
      return { pagesQueued: rest, pagesScanned: [url], findings, inventories: [inventory] };
    } catch (err) {
      return { pagesQueued: rest, errors: [{ node: 'scanPage', url, message: err.message }] };
    }
  }

  /**
   * Cross-page safety dedupe + the single write to SQLite. Per-page dedupe has
   * already run inside scanPage; this catches anything a resumed/re-scanned page
   * duplicated. State keeps the union, the DB holds the deduped truth that the
   * reports read.
   */
  async function normalize(state) {
    const findings = dedupe(state.findings);
    insertFindings(db, findings);
    log(`normalize: ${state.findings.length} findings -> ${findings.length} persisted`);
    return {};
  }

  async function assessWithAI(state) {
    if (client.ai?.enabled === false) return {};
    const out = [];
    const errors = [];
    for (const inventory of state.inventories) {
      const ctx = { runId: state.runId, pageUrl: inventory.pageUrl, screenshotDir: join(runDir(state.runId), 'screenshots') };
      const res = await assessPage({ gemini, kb, inventory, ctx, cfg: client.ai ?? {} });
      out.push(...res.findings);
      for (const e of res.errors) {
        // An AI node erroring must never silently drop the page's candidates.
        escalate(state.runId, null, `AI task ${e.task} failed: ${e.message}`, { pageUrl: inventory.pageUrl, items: e.items });
        errors.push({ node: 'assessWithAI', ...e });
      }
    }
    if (out.length) insertFindings(db, out);
    log(`assessWithAI: ${out.length} AI findings, ${errors.length} task errors escalated`);
    return { findings: out, errors };
  }

  async function group(state) {
    const fixable = state.findings.filter((f) => f.domSelector && f.htmlSnippet && !f.domSelector.includes(' , '));
    const groups = groupComponents(fixable, client.graph?.grouping ?? {});
    log(`groupComponents: ${groups.length} components from ${fixable.length} fixable findings`);
    return { componentQueue: groups };
  }

  async function nextComponent(state) {
    const [current, ...rest] = state.componentQueue;
    return { currentComponent: current ?? null, componentQueue: rest, fixAttempts: 0, failureReason: null, proposedFix: null, verificationResult: null };
  }

  async function retrieveGuidanceNode(state) {
    const docs = [];
    for (const f of state.currentComponent.findings.slice(0, 4)) docs.push(...(await retrieveGuidance(kb, f, 1)));
    return { guidance: guidanceText(docs.filter(Boolean)) };
  }

  async function generateFix(state) {
    try {
      const fixes = await generateFixes({
        gemini, kb, group: state.currentComponent,
        failureReason: state.failureReason, attempt: state.fixAttempts,
      });
      return { proposedFix: fixes, fixAttempts: state.fixAttempts + 1 };
    } catch (err) {
      for (const f of state.currentComponent.findings) escalate(state.runId, f, `fix generation failed: ${err.message}`, { component: state.currentComponent.key });
      return { proposedFix: [], fixAttempts: maxAttempts, errors: [{ node: 'generateFix', message: err.message }] };
    }
  }

  async function verify(state) {
    const fixes = state.proposedFix ?? [];
    if (!fixes.length) return { verificationResult: 'unresolved', failureReason: 'model produced no fixes for this component' };

    const verified = [];
    const failed = [];
    const unverifiable = [];
    for (const fix of fixes) {
      const result = await verifyFix(session, fix, { navTimeoutMs: client.browser.navTimeoutMs });
      const row = {
        id: randomUUID().slice(0, 18), runId: state.runId, findingId: fix.findingId,
        attempts: state.fixAttempts, before: fix.before, after: fix.after,
        explanation: fix.explanation, verification: result.status, verifyNotes: result.notes,
        model: gemini.model, createdAt: new Date().toISOString(),
      };
      insert(db, 'fixes', row);
      const bucket = result.status === 'verified' ? verified : result.status === 'unverified' ? unverifiable : failed;
      bucket.push({ ...fix, result });
    }
    // Retrying something axe can never confirm is a loop with no exit condition.
    for (const fix of unverifiable) escalate(state.runId, fix.finding, `suggestion needs auditor review: ${fix.result.notes}`, { component: state.currentComponent.key, after: fix.after });
    log(`verifyFix: ${verified.length} verified, ${unverifiable.length} unverifiable (sent to review), ${failed.length} failed (attempt ${state.fixAttempts}/${maxAttempts})`);

    if (!failed.length) return { verificationResult: 'verified', completedFixes: verified };
    return {
      verificationResult: failed.some((f) => f.result.status === 'regressed') ? 'regressed' : 'unresolved',
      completedFixes: verified,
      failureReason: failed.map((f) => `${f.findingId}: ${f.result.status} — ${f.result.notes}`).join('\n'),
      // Narrow the retry to what actually failed.
      currentComponent: { ...state.currentComponent, findings: state.currentComponent.findings.filter((x) => failed.some((f) => f.findingId === x.id)) },
    };
  }

  async function escalateToHuman(state) {
    const findings = state.currentComponent?.findings ?? [];
    if (client.graph?.interruptOnEscalation) {
      interrupt({ type: 'fix-review', component: state.currentComponent?.key, findings: findings.map((f) => f.id), reason: state.failureReason });
    }
    for (const f of findings) {
      escalate(state.runId, f, `no verified fix after ${maxAttempts} attempts (${state.verificationResult})`, {
        component: state.currentComponent?.key, failureReason: state.failureReason, lastProposed: state.proposedFix,
      });
    }
    log(`escalateToHuman: ${findings.length} findings queued for an auditor`);
    return { abandonedFindings: findings };
  }

  async function report(state) {
    finishRun(db, state.runId);
    const dir = runDir(state.runId);
    const paths = {
      json: writeJson(db, state.runId, join(dir, 'report.json')),
      html: writeHtml(db, state.runId, join(dir, 'report.html')),
      vpat: writeVpat(db, state.runId, join(dir, 'vpat-draft.md'), criteriaCatalogue(kb)),
    };
    log(`report: ${Object.values(paths).join(', ')}`);
    return { reportPaths: paths };
  }

  // ------------------------------------------------------------- edges

  return new StateGraph(AuditState)
    .addNode('login', login)
    .addNode('crawl', crawlNode)
    .addNode('scanPage', scanPageNode)
    .addNode('normalize', normalize)
    .addNode('assessWithAI', assessWithAI)
    .addNode('groupComponents', group)
    .addNode('nextComponent', nextComponent)
    .addNode('retrieveGuidance', retrieveGuidanceNode)
    .addNode('generateFix', generateFix)
    .addNode('verifyFix', verify)
    .addNode('escalateToHuman', escalateToHuman)
    .addNode('report', report)
    .addEdge(START, 'login')
    .addEdge('login', 'crawl')
    .addEdge('crawl', 'scanPage')
    .addConditionalEdges('scanPage', (s) => (s.pagesQueued.length ? 'scanPage' : 'normalize'), {
      scanPage: 'scanPage',
      normalize: 'normalize',
    })
    .addEdge('normalize', 'assessWithAI')
    .addEdge('assessWithAI', 'groupComponents')
    .addEdge('groupComponents', 'nextComponent')
    .addConditionalEdges('nextComponent', (s) => (s.currentComponent ? 'retrieveGuidance' : 'report'), {
      retrieveGuidance: 'retrieveGuidance',
      report: 'report',
    })
    .addEdge('retrieveGuidance', 'generateFix')
    .addEdge('generateFix', 'verifyFix')
    .addConditionalEdges(
      'verifyFix',
      (s) => {
        if (s.verificationResult === 'verified') return 'nextComponent';
        if (s.fixAttempts < maxAttempts) return 'generateFix'; // the cycle LangGraph exists for
        return 'escalateToHuman';
      },
      { nextComponent: 'nextComponent', generateFix: 'generateFix', escalateToHuman: 'escalateToHuman' }
    )
    .addEdge('escalateToHuman', 'nextComponent')
    .addEdge('report', END);
}

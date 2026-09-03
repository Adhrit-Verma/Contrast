#!/usr/bin/env node
import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { loadConfig, clientConfig, resolveTarget, groupTree } from './config.js';
import { applySecrets } from './secrets.js';
import { launch, interactiveLogin, openSession } from './browser/session.js';
import { crawl } from './browser/crawl.js';
import { openDb, listRuns, getFindings, insert, insertFindings, insertReview, setRunNotes } from './db.js';
import { scanPage, startRun, finishRun, runDir } from './scan/index.js';
import { assessPage } from './ai/tasks.js';
import { createGemini } from './ai/gemini.js';
import { loadKnowledge, criteriaCatalogue } from './ai/knowledge.js';
import { writeJson, writeHtml, writeDiffHtml, writeVpat, buildReport } from './report/index.js';

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();
// A key saved in the dashboard reaches every command, including jobs the
// dashboard spawns, without ever being written to config.json.
applySecrets(cfg.session?.dir ?? 'sessions');
const db = () => openDb(cfg.db?.path ?? 'runs/audit.sqlite');

const USAGE = `
usage: node src/cli.js <command>

  run    <client|group> [--scope=scan|assess|full]
                                  the one you want: crawls, scans, and pauses for
                                  login when the site asks for one
  login  <client>                 headed manual login, stores an encrypted session
  crawl  <client>                 discover pages only (read-only guard on)
  scan   <client>                 crawl + Phase 2 deterministic scan -> SQLite
  assess <client> <runId>         Phase 3 Gemini judgment over a scanned run
  audit  <client> [--resume <t>]  full LangGraph pipeline: scan -> assess -> fix -> verify -> report
  report <runId>                  write report.json + report.html
  vpat   <runId>                  write the VPAT/ACR first draft
  diff   <baseRunId> <headRunId>  re-audit diff: fixed / new / still broken
  runs                            list runs
  ui     [port]                   browse runs, reports and diffs at http://localhost:4321
`;

const need = (v, msg) => {
  if (!v) {
    console.log(msg);
    process.exit(1);
  }
  return v;
};

switch (cmd) {
  case 'login': {
    const client = clientConfig(cfg, need(args[0], USAGE));
    const browser = await launch(client.browser);
    await interactiveLogin(browser, client);
    await browser.close();
    break;
  }

  case 'crawl': {
    const client = clientConfig(cfg, need(args[0], USAGE));
    const blocked = [];
    const session = await openSession(client, { onBlocked: (url, method, reason) => blocked.push({ url, method, reason }) });
    const pages = await crawl(session, client);
    console.log(`\n${pages.length} pages, ${blocked.length} requests blocked by the read-only guard`);
    for (const b of blocked.slice(0, 10)) console.log(`  blocked ${b.method} ${b.url} (${b.reason})`);
    await session.browser.close();
    break;
  }

  case 'scan': {
    const client = clientConfig(cfg, need(args[0], USAGE));
    if (client.scan.lighthouse && client.crawl.concurrency > 1) {
      console.log('lighthouse drives the whole tab — forcing crawl concurrency to 1');
      client.crawl.concurrency = 1;
    }
    const database = db();
    const runId = startRun(database, client);
    console.log(`run ${runId}`);
    const session = await openSession(client);
    let total = 0;
    const scanned = new Set();
    const visited = await crawl(
      session, client,
      async (page, info) => {
        const { findings } = await scanPage(page, info, { runId, client, db: database });
        scanned.add(info.finalUrl ?? info.url);
        total += findings.length;
      },
      { onAbandoned: (reason) => setRunNotes(database, runId, reason) }
    );
    recordUnscannedPages(database, runId, visited, scanned);
    finishRun(database, runId);
    await session.browser.close();
    console.log(`\n${total} findings → run ${runId}`);
    console.log(`next: node src/cli.js assess ${client.id} ${runId}`);
    break;
  }

  case 'assess': {
    const client = clientConfig(cfg, need(args[0], USAGE));
    const runId = need(args[1], USAGE);
    const database = db();
    const gemini = createGemini({ ai: client.ai, db: database });
    const kb = await loadKnowledge({ dir: client.ai.knowledgeDir ?? 'knowledge', gemini });
    const inventories = loadInventories(runId);
    console.log(`assessing ${inventories.length} page inventories (${gemini.available ? gemini.model : 'NO API KEY — will fail'})`);
    let all = [];
    for (const inventory of inventories) {
      const ctx = { runId, pageUrl: inventory.pageUrl, screenshotDir: join(runDir(runId), 'screenshots') };
      const { findings, errors } = await assessPage({ gemini, kb, inventory, ctx, cfg: client.ai });
      all.push(...findings);
      for (const e of errors) {
        console.log(`  ! ${e.task}: ${e.message}`);
        // Console output does not survive the run — this is what lets an
        // auditor see why a page's AI findings are thin without re-running it.
        insertReview(database, runId, null, `AI task ${e.task} failed: ${e.message}`, { pageUrl: inventory.pageUrl, items: e.items });
      }
    }
    insertFindings(database, all);
    console.log(`${all.length} AI findings added to run ${runId}`, gemini.stats());
    break;
  }

  // One entry point. Works on a client or a whole group, decides for itself
  // when a human is needed, and stalls instead of failing when one is.
  case 'run': {
    const target = resolveTarget(cfg, need(args[0], USAGE));
    const scope = (args.find((a) => a.startsWith('--scope='))?.split('=')[1] ?? 'scan');
    console.log(`[target] ${target.kind} "${target.label}" — ${target.clientIds.length} site(s), scope: ${scope}`);
    const database = db();

    for (const [i, clientId] of target.clientIds.entries()) {
      const client = clientConfig(cfg, clientId);
      console.log(`\n[site ${i + 1}/${target.clientIds.length}] ${client.label ?? clientId} — ${client.seedUrl}`);
      if (scope === 'full') {
        const { runAudit } = await import('./graph/run.js');
        await runAudit(client, cfg);
        continue;
      }
      if (client.scan.lighthouse && client.crawl.concurrency > 1) client.crawl.concurrency = 1;

      const runId = startRun(database, client);
      console.log(`run ${runId}`);
      const session = await openSession(client);
      let total = 0;
      const scanned = new Set();
      const visited = await crawl(
        session, client,
        async (page, info) => {
          const { findings } = await scanPage(page, info, { runId, client, db: database });
          scanned.add(info.finalUrl ?? info.url);
          total += findings.length;
        },
        {
          onSessionExpired: (url) => interactiveLogin(session.browser, client, { url, why: 'the session expired mid-crawl' }),
          onAbandoned: (reason) => setRunNotes(database, runId, reason),
        }
      );
      recordUnscannedPages(database, runId, visited, scanned);
      finishRun(database, runId);

      if (scope === 'assess' || scope === 'ai') {
        const gemini = createGemini({ ai: client.ai, db: database });
        const kb = await loadKnowledge({ dir: client.ai.knowledgeDir ?? 'knowledge', gemini });
        const inventories = loadInventories(runId);
        console.log(`[stage] assessing ${inventories.length} pages with ${gemini.model}`);
        const ai = [];
        for (const inventory of inventories) {
          const ctx = { runId, pageUrl: inventory.pageUrl, screenshotDir: join(runDir(runId), 'screenshots') };
          const { findings, errors } = await assessPage({ gemini, kb, inventory, ctx, cfg: client.ai });
          ai.push(...findings);
          for (const e of errors) {
            console.log(`  ! ${e.task}: ${e.message}`);
            insertReview(database, runId, null, `AI task ${e.task} failed: ${e.message}`, { pageUrl: inventory.pageUrl, items: e.items });
          }
        }
        insertFindings(database, ai);
        total += ai.length;
        console.log(`[stage] ${ai.length} AI findings`);
      }
      await session.browser.close();
      console.log(`${total} findings → run ${runId}`);
    }
    console.log('\n[done] all sites complete');
    break;
  }

  case 'audit': {
    const client = clientConfig(cfg, need(args[0], USAGE));
    const { runAudit } = await import('./graph/run.js');
    await runAudit(client, cfg, args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null);
    break;
  }

  case 'report': {
    const runId = need(args[0], USAGE);
    const database = db();
    const dir = runDir(runId);
    // The catalogue is what lets the report say which criteria a machine could
    // not check at all, rather than implying silence means conformance.
    const catalogue = criteriaCatalogue(await loadKnowledge({ dir: cfg.ai?.knowledgeDir ?? 'knowledge' }));
    console.log(writeJson(database, runId, join(dir, 'report.json'), catalogue));
    console.log(writeHtml(database, runId, join(dir, 'report.html'), catalogue));
    console.log(JSON.stringify(buildReport(database, runId, catalogue).summary, null, 2));
    break;
  }

  case 'vpat': {
    const runId = need(args[0], USAGE);
    const kb = await loadKnowledge({ dir: cfg.ai?.knowledgeDir ?? 'knowledge' });
    console.log(writeVpat(db(), runId, join(runDir(runId), 'vpat-draft.md'), criteriaCatalogue(kb)));
    break;
  }

  case 'diff': {
    const [base, head] = [need(args[0], USAGE), need(args[1], USAGE)];
    console.log(writeDiffHtml(db(), base, head, join(runDir(head), `diff-vs-${base}.html`)));
    break;
  }

  case 'runs': {
    for (const r of listRuns(db())) {
      const n = getFindings(db(), r.id).length;
      console.log(`${r.id}  ${r.clientId.padEnd(12)} ${String(n).padStart(5)} findings  ${r.finishedAt ? 'done' : 'INCOMPLETE'}  ${r.seedUrl}${r.notes ? `\n    ⚠ ${r.notes}` : ''}`);
    }
    break;
  }

  case 'ui': {
    const { startUi } = await import('./ui/server.js');
    startUi({ cfg, port: Number(args[0]) || 4321 });
    break;
  }

  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}

/**
 * A page crawl.js already flagged with `.error` — blocked, a dead link, a
 * session that never recovered — never reaches scanPage and so never gets a
 * `pages` row on its own. Give it one so the run's per-page trace is complete
 * without needing the console scrollback to explain the gap.
 */
function recordUnscannedPages(database, runId, visited, scanned) {
  for (const v of visited) {
    const url = v.finalUrl ?? v.url;
    if (v.error && !scanned.has(url)) {
      insert(database, 'pages', {
        runId, url: v.url, finalUrl: v.finalUrl ?? null, title: v.title ?? null,
        status: v.status ?? null, screenshotPath: null, a11yTree: null, error: v.error,
      });
    }
  }
}

function loadInventories(runId) {
  const dir = join(runDir(runId), 'inventory');
  if (!existsSync(dir)) {
    console.log(`no inventory for run ${runId} — run "scan" first`);
    process.exit(1);
  }
  return readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

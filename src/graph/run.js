// Driver for the Phase 7 graph: compiles it with the SQLite checkpointer and
// services interrupts (manual login, fix escalation) from the CLI.
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAuditGraph } from './audit.js';
import { openSession, interactiveLogin } from '../browser/session.js';
import { openDb } from '../db.js';
import { createGemini } from '../ai/gemini.js';
import { loadKnowledge } from '../ai/knowledge.js';

export async function runAudit(client, cfg, resumeThread = null) {
  if (client.scan.lighthouse && client.crawl.concurrency > 1) {
    console.log('lighthouse drives the whole tab — forcing crawl concurrency to 1');
    client.crawl.concurrency = 1;
  }
  const db = openDb(client.db?.path ?? 'runs/audit.sqlite');
  const gemini = createGemini({ ai: client.ai, db });
  const kb = await loadKnowledge({ dir: client.ai?.knowledgeDir ?? 'knowledge', gemini });
  const session = await openSession(client, { autoLogin: false });

  const checkpointPath = client.graph?.checkpointPath ?? 'runs/checkpoints.sqlite';
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const checkpointer = SqliteSaver.fromConnString(checkpointPath);

  const app = buildAuditGraph({ client, db, session, gemini, kb }).compile({ checkpointer });
  const threadId = resumeThread ?? `${client.id}-${randomUUID().slice(0, 8)}`;
  const config = { configurable: { thread_id: threadId }, recursionLimit: client.graph?.recursionLimit ?? 2000 };
  console.log(`thread ${threadId}${resumeThread ? ' (resuming)' : ''} — resume with: node src/cli.js audit ${client.id} --resume ${threadId}`);

  try {
    let input = resumeThread ? new Command({ resume: 'resumed' }) : {};
    for (;;) {
      await app.invoke(input, config);
      const snapshot = await app.getState(config);
      const pending = (snapshot.tasks ?? []).flatMap((t) => t.interrupts ?? []);
      if (!pending.length) break;

      for (const it of pending) await handleInterrupt(it.value, { client, session });
      input = new Command({ resume: 'ok' });
    }
    const final = await app.getState(config);
    console.log('\ndone:', JSON.stringify(final.values.reportPaths ?? {}, null, 2));
    console.log('gemini:', JSON.stringify(gemini.stats()));
    if (final.values.errors?.length) console.log(`${final.values.errors.length} node errors — see the review queue in the report`);
  } finally {
    await session.browser.close().catch(() => {});
  }
}

async function handleInterrupt(value, { client, session }) {
  if (value?.type === 'manual-login') {
    console.log(`\n[interrupt] manual login required for ${value.clientId}`);
    await interactiveLogin(session.browser, client);
    session.loggedIn = true;
    await session.page.goto(client.seedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return;
  }
  if (value?.type === 'fix-review') {
    console.log(`\n[interrupt] fix review needed for component ${value.component}: ${value.reason ?? ''}`);
    console.log(`  findings: ${(value.findings ?? []).join(', ')}`);
    console.log('  logged to the review queue; press Enter in the terminal to continue.');
    return;
  }
  console.log('[interrupt]', JSON.stringify(value));
}

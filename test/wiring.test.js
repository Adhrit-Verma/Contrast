import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createBudget, ceilingFromConfig } from '../src/ai/budget.js';
import { createProvider, PAID, FREE } from '../src/ai/provider.js';
import { assessPage } from '../src/ai/tasks.js';

/**
 * These pin the seam between the router and the code that consumes it. The
 * modules were unit-tested and still dead — nothing imported them — so what
 * matters here is that `assessPage()` can be handed a provider and behave.
 */

const stub = ({ available = true, model = 'gpt-5.6-luna', usage = { inputTokens: 1000, outputTokens: 200 }, fail = null } = {}) => {
  const calls = [];
  return {
    available, model, calls,
    generate: async (a) => {
      calls.push(a);
      if (fail) throw new Error(fail);
      return { data: { findings: [] }, cached: false, usage };
    },
    stats: () => ({ calls: calls.length }),
  };
};

async function withDb(fn) {
  const path = `runs/__test-wiring-${randomUUID()}.sqlite`;
  const db = openDb(path);
  try { return await fn(db); } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  }
}

const kb = {
  chunks: [],
  criterion: (n) => ({ id: n, file: 'wcag/criteria.md', heading: n + ' Test', text: 'guidance' }),
  search: async () => [],
};

const inventory = {
  pageUrl: 'https://example.com/',
  images: [{ src: '/a.png', alt: 'a.png', selector: 'img' }],
  links: [], headings: [], fields: [], blocks: [],
};

test('ceilingFromConfig prefers the environment, then config, then a safe default', () => {
  delete process.env.AI_MONTHLY_CEILING_USD;
  assert.equal(ceilingFromConfig({}), 24);
  assert.equal(ceilingFromConfig({ monthlyCeilingUsd: 5 }), 5);
  process.env.AI_MONTHLY_CEILING_USD = '3';
  assert.equal(ceilingFromConfig({ monthlyCeilingUsd: 5 }), 3, 'the environment wins, as it does for keys');
  delete process.env.AI_MONTHLY_CEILING_USD;
});

test('a provider can stand in for the raw client assessPage() expects', async () => {
  await withDb(async (db) => {
    const openai = stub();
    const provider = createProvider({
      db, budget: createBudget({ db, ceilingUsd: 10 }),
      log: () => {}, openai, gemini: stub({ available: false }), defaultEntitlement: PAID,
    });
    // The seam that was missing: assessPage takes whatever exposes generate().
    const { errors } = await assessPage({
      gemini: provider, kb, inventory,
      ctx: { runId: 'r1', pageUrl: inventory.pageUrl, screenshotDir: 'runs/x' },
      cfg: { tasks: { 'alt-text-quality': true } },
    });
    assert.deepEqual(errors, [], 'no task should have errored');
    assert.ok(openai.calls.length > 0, 'the paid model should have been reached through the provider');
  });
});

test('the monthly ceiling actually stops paid spending — it is not a decorative setting', async () => {
  await withDb(async (db) => {
    // A ceiling of ~nothing. The estimate for any real call exceeds it.
    const budget = createBudget({ db, ceilingUsd: 0.0000001 });
    const openai = stub();
    const gemini = stub({ model: 'gemini-2.5-flash' });
    const provider = createProvider({ db, budget, log: () => {}, openai, gemini, defaultEntitlement: PAID });

    const res = await provider.assess({ task: 't', prompt: 'p'.repeat(4000), schema: { type: 'object', properties: {} } });
    assert.equal(openai.calls.length, 0, 'the ceiling must refuse the call before it is made');
    assert.equal(res.provider, 'gemini', 'and degrade rather than fail');
  });
});

test('spend from a real assessment lands in the ledger', async () => {
  await withDb(async (db) => {
    const budget = createBudget({ db, ceilingUsd: 10 });
    const provider = createProvider({
      db, budget, log: () => {},
      openai: stub({ model: 'gpt-5.6-terra', usage: { inputTokens: 1e6, outputTokens: 0 } }),
      gemini: stub({ available: false }), defaultEntitlement: PAID,
    });
    assert.equal(budget.spentThisMonth(), 0);
    await provider.generate({ task: 't', prompt: 'p', schema: { type: 'object', properties: {} }, model: 'gpt-5.6-terra' });
    assert.equal(Number(budget.spentThisMonth().toFixed(4)), 2.0, 'the run must be visible in ai_spend');
  });
});

test('generate() throws when nothing can run, so the caller escalates instead of passing silently', async () => {
  await withDb(async (db) => {
    const provider = createProvider({
      db, budget: createBudget({ db }), log: () => {},
      openai: stub({ available: false }), gemini: stub({ available: false }),
    });
    await assert.rejects(
      () => provider.generate({ task: 'alt-text', prompt: 'p', schema: { type: 'object', properties: {} } }),
      /no AI available for alt-text/
    );
  });
});

test('a provider handed to assessPage records task failures rather than inventing findings', async () => {
  await withDb(async (db) => {
    const provider = createProvider({
      db, budget: createBudget({ db }), log: () => {},
      openai: stub({ available: false }), gemini: stub({ available: false }), defaultEntitlement: PAID,
    });
    const { findings, errors } = await assessPage({
      gemini: provider, kb, inventory,
      ctx: { runId: 'r1', pageUrl: inventory.pageUrl, screenshotDir: 'runs/x' },
      cfg: { tasks: { 'alt-text-quality': true } },
    });
    assert.equal(findings.length, 0, 'a failed assessment must produce no findings');
    assert.ok(errors.length > 0, 'and must be reported so it reaches the review queue');
  });
});

test('the default entitlement decides which model a caller reaches', async () => {
  await withDb(async (db) => {
    const openai = stub();
    const gemini = stub({ model: 'gemini-2.5-flash' });
    const paid = createProvider({ db, budget: createBudget({ db, ceilingUsd: 10 }), log: () => {}, openai, gemini, defaultEntitlement: PAID });
    const free = createProvider({ db, budget: createBudget({ db, ceilingUsd: 10 }), log: () => {}, openai, gemini, defaultEntitlement: FREE });

    await paid.generate({ task: 't', prompt: 'p', schema: { type: 'object', properties: {} } });
    assert.equal(openai.calls.length, 1);
    await free.generate({ task: 't', prompt: 'p', schema: { type: 'object', properties: {} } });
    assert.equal(openai.calls.length, 1, 'a FREE-default provider must not reach the paid model');
  });
});

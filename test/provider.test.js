import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createBudget } from '../src/ai/budget.js';
import { createProvider, PAID, FREE } from '../src/ai/provider.js';

/** Stand-in clients — no network, no keys, no spend. */
const stubClient = ({ available = true, model = 'gpt-5.6-luna', reply = { verdict: 'ok' }, usage = { inputTokens: 1000, outputTokens: 500 }, fail = null } = {}) => {
  const calls = [];
  return {
    available, model, calls,
    generate: async (args) => {
      calls.push(args);
      if (fail) throw new Error(fail);
      return { data: reply, cached: false, usage };
    },
    stats: () => ({ calls: calls.length }),
  };
};

async function withDb(fn) {
  const path = `runs/__test-provider-${randomUUID()}.sqlite`;
  const db = openDb(path);
  try { return await fn(db); } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  }
}

const ask = (provider, over = {}) =>
  provider.assess({ task: 't', prompt: 'p', schema: { type: 'object', properties: {} }, ...over });

// ---------------------------------------------------------- the money boundary

test('a FREE request never reaches the paid model, even when it is available', async () => {
  await withDb(async (db) => {
    const openai = stubClient({ model: 'gpt-5.6-luna' });
    const gemini = stubClient({ model: 'gemini-2.5-flash' });
    const provider = createProvider({ db, budget: createBudget({ db }), log: () => {}, openai, gemini });

    const res = await ask(provider, { entitlement: FREE });
    assert.equal(res.provider, 'gemini');
    assert.equal(openai.calls.length, 0, 'a free scan must never spend paid-model money');
  });
});

test('a FREE request degrades to deterministic rather than borrowing the paid model', async () => {
  await withDb(async (db) => {
    const openai = stubClient();                       // healthy and available…
    const gemini = stubClient({ available: false });    // …but the free tier is down
    const provider = createProvider({ db, budget: createBudget({ db }), log: () => {}, openai, gemini });

    const res = await ask(provider, { entitlement: FREE });
    assert.equal(res.ok, false);
    assert.equal(res.degraded, 'deterministic');
    assert.equal(openai.calls.length, 0, 'the paid model is not a fallback for free users');
  });
});

test('a PAID request uses the paid model and records real usage, not the estimate', async () => {
  await withDb(async (db) => {
    const budget = createBudget({ db, ceilingUsd: 10 });
    const openai = stubClient({ model: 'gpt-5.6-terra', usage: { inputTokens: 1e6, outputTokens: 0 } });
    const provider = createProvider({ db, budget, log: () => {}, openai, gemini: stubClient() });

    const res = await ask(provider, { entitlement: PAID, model: 'gpt-5.6-terra' });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'openai');
    // gpt-5.6-terra is $2.00/1M in — the settled cost must match the usage,
    // not whatever the pre-flight guess happened to be.
    assert.equal(Number(res.costUsd.toFixed(4)), 2.0);
    assert.equal(Number(budget.spentThisMonth().toFixed(4)), 2.0);
  });
});

test('credit-funded work draws on the credit, leaving the operator ceiling alone', async () => {
  await withDb(async (db) => {
    const budget = createBudget({ db, ceilingUsd: 10 });
    const creditId = budget.addCredit({ source: 'unlock', amountUsd: 7 });
    const openai = stubClient({ model: 'gpt-5.6-terra', usage: { inputTokens: 1e6, outputTokens: 0 } });
    const provider = createProvider({ db, budget, log: () => {}, openai, gemini: stubClient() });

    await ask(provider, { entitlement: PAID, model: 'gpt-5.6-terra', creditId });
    assert.equal(budget.spentThisMonth(), 0, 'the customer paid for this, not the operator');
    assert.equal(Number(budget.remaining(creditId).toFixed(4)), 5.0);
  });
});

// -------------------------------------------------------------- the degrade path

test('an exhausted budget falls back to the free tier rather than failing', async () => {
  await withDb(async (db) => {
    const budget = createBudget({ db, ceilingUsd: 0.0001 }); // effectively nothing left
    const openai = stubClient();
    const gemini = stubClient({ model: 'gemini-2.5-flash' });
    const provider = createProvider({ db, budget, log: () => {}, openai, gemini });

    const res = await ask(provider, { entitlement: PAID, model: 'gpt-5.6-sol' });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'gemini', 'out of money is not out of service');
    assert.equal(openai.calls.length, 0, 'the call must be refused before it is made, not after');
  });
});

test('a paid-model failure falls through to the free tier', async () => {
  await withDb(async (db) => {
    const openai = stubClient({ fail: 'OpenAI 503: upstream' });
    const gemini = stubClient({ model: 'gemini-2.5-flash' });
    const provider = createProvider({ db, budget: createBudget({ db }), log: () => {}, openai, gemini });

    const res = await ask(provider, { entitlement: PAID });
    assert.equal(res.provider, 'gemini');
  });
});

test('when nothing can run, the caller is told why — not handed an exception', async () => {
  await withDb(async (db) => {
    const provider = createProvider({
      db, budget: createBudget({ db }), log: () => {},
      openai: stubClient({ available: false }), gemini: stubClient({ available: false }),
    });
    const res = await ask(provider, { entitlement: PAID });
    assert.equal(res.ok, false);
    assert.equal(res.degraded, 'deterministic');
    assert.match(res.reason, /openai: no API key/);
    assert.match(res.reason, /gemini: no API key/);
    assert.equal(res.data, null);
  });
});

test('both providers failing degrades rather than throwing', async () => {
  await withDb(async (db) => {
    const provider = createProvider({
      db, budget: createBudget({ db }), log: () => {},
      openai: stubClient({ fail: 'boom' }), gemini: stubClient({ fail: 'quota exceeded' }),
    });
    const res = await ask(provider, { entitlement: PAID });
    assert.equal(res.degraded, 'deterministic');
    assert.match(res.reason, /quota exceeded/);
  });
});

// ------------------------------------------------------------------------ mode

test('mode reports what this run can actually do', async () => {
  await withDb(async (db) => {
    const both = createProvider({ db, budget: createBudget({ db }), log: () => {}, openai: stubClient(), gemini: stubClient() });
    assert.equal(both.mode(PAID), PAID);
    assert.equal(both.mode(FREE), FREE, 'a free caller is on the free tier even when paid is healthy');

    const freeOnly = createProvider({ db, log: () => {}, openai: stubClient({ available: false }), gemini: stubClient() });
    assert.equal(freeOnly.mode(PAID), FREE);

    const neither = createProvider({ db, log: () => {}, openai: stubClient({ available: false }), gemini: stubClient({ available: false }) });
    assert.equal(neither.mode(PAID), 'deterministic');
  });
});

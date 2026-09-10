import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createBudget, costUsd, priceFor, BudgetExceededError, estimateTokens } from '../src/ai/budget.js';

/** Each test gets its own database file so spend from one cannot fund another. */
function withBudget(fn, opts = {}) {
  const path = `runs/__test-budget-${randomUUID()}.sqlite`;
  const db = openDb(path);
  try {
    fn(createBudget({ db, ...opts }), db);
  } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  }
}

test('an unknown model is a hard error, never a silent zero', () => {
  assert.throws(() => priceFor('gpt-9-imaginary'), /No price known/);
});

test('cost is computed from real per-1M rates', () => {
  // gpt-5.6-luna: $0.20 in / $1.20 out per 1M
  assert.equal(costUsd({ model: 'gpt-5.6-luna', inputTokens: 1e6, outputTokens: 0 }), 0.2);
  assert.equal(costUsd({ model: 'gpt-5.6-luna', inputTokens: 0, outputTokens: 1e6 }), 1.2);
  // A realistic 100-image scan on luna should cost well under a cent.
  const scan = costUsd({ model: 'gpt-5.6-luna', inputTokens: estimateTokens({ images: 100 }), outputTokens: 5000 });
  assert.ok(scan < 0.03, `expected under $0.03, got $${scan}`);
});

test('spend accumulates against the monthly ceiling', () => {
  withBudget((budget) => {
    assert.equal(budget.spentThisMonth(), 0);
    budget.settle({ provider: 'openai', model: 'gpt-5.6-terra', task: 't', inputTokens: 1e6 });
    assert.equal(Number(budget.spentThisMonth().toFixed(4)), 2.0);
    assert.equal(Number(budget.remaining().toFixed(4)), 8.0);
  }, { ceilingUsd: 10 });
});

test('reserve refuses a call that would exceed the ceiling', () => {
  withBudget((budget) => {
    budget.settle({ provider: 'openai', model: 'gpt-5.6-sol', task: 't', inputTokens: 2e6 }); // $8
    assert.ok(budget.canAfford(1.5));
    assert.equal(budget.canAfford(2.5), false);
    assert.doesNotThrow(() => budget.reserve(1.5));
    assert.throws(() => budget.reserve(2.5), BudgetExceededError);
  }, { ceilingUsd: 10 });
});

test('a BudgetExceededError says which bucket and by how much', () => {
  withBudget((budget) => {
    try {
      budget.reserve(99);
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.bucket, 'ceiling');
      assert.equal(err.needUsd, 99);
      assert.equal(err.haveUsd, 10);
    }
  }, { ceilingUsd: 10 });
});

test('credit-funded spend does not touch the operator ceiling', () => {
  withBudget((budget) => {
    const creditId = budget.addCredit({ source: 'unlock', amountUsd: 7, ref: 'order-1' });
    budget.settle({ provider: 'openai', model: 'gpt-5.6-terra', task: 't', inputTokens: 1e6, creditId }); // $2
    // The money came from the customer, so the operator's month is untouched.
    assert.equal(budget.spentThisMonth(), 0);
    assert.equal(Number(budget.remaining()).toFixed(4), '10.0000');
    assert.equal(Number(budget.remaining(creditId).toFixed(4)), 5.0);
  }, { ceilingUsd: 10 });
});

test('a credit cannot be overdrawn', () => {
  withBudget((budget) => {
    const creditId = budget.addCredit({ source: 'unlock', amountUsd: 1 });
    assert.doesNotThrow(() => budget.reserve(0.9, creditId));
    assert.throws(() => budget.reserve(1.5, creditId), /has \$1\.0000 left/);
    budget.settle({ provider: 'openai', model: 'gpt-5.6-terra', task: 't', inputTokens: 5e5, creditId }); // $1
    assert.equal(budget.remaining(creditId), 0);
    assert.throws(() => budget.reserve(0.01, creditId), BudgetExceededError);
  }, { ceilingUsd: 10 });
});

test('one customer credit cannot be spent by another request', () => {
  withBudget((budget) => {
    const mine = budget.addCredit({ source: 'unlock', amountUsd: 5, customerId: 'a' });
    const theirs = budget.addCredit({ source: 'unlock', amountUsd: 0, customerId: 'b' });
    assert.ok(budget.canAfford(4, mine));
    assert.equal(budget.canAfford(4, theirs), false, 'an empty credit must not borrow from a funded one');
  }, { ceilingUsd: 10 });
});

test('an unknown credit id has no money, rather than defaulting to the ceiling', () => {
  withBudget((budget) => {
    assert.equal(budget.remaining('no-such-credit'), 0);
    assert.throws(() => budget.reserve(0.01, 'no-such-credit'), BudgetExceededError);
  }, { ceilingUsd: 10 });
});

test('last month\'s spend does not count against this month', () => {
  const path = `runs/__test-budget-${randomUUID()}.sqlite`;
  const db = openDb(path);
  try {
    const inJune = new Date('2026-06-15T00:00:00Z');
    const inJuly = new Date('2026-07-15T00:00:00Z');
    let clock = inJune;
    const budget = createBudget({ db, ceilingUsd: 10, now: () => clock });
    budget.settle({ provider: 'openai', model: 'gpt-5.6-sol', task: 't', inputTokens: 2e6 }); // $8 in June
    assert.equal(Number(budget.spentThisMonth().toFixed(4)), 8);
    clock = inJuly;
    assert.equal(budget.spentThisMonth(), 0, 'the ceiling resets on a calendar month');
    assert.equal(budget.remaining(), 10);
  } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  }
});

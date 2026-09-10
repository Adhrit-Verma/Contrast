// Money, not requests.
//
// limiter.js already caps how FAST and how MANY calls happen. This caps how
// much they COST, which is a different failure: a hundred cheap calls and one
// expensive one can both be "within the rate limit" and only one of them ends
// the project.
//
// The governing rule is that a paid analysis is never run with money that has
// not already been collected. That splits spend into two buckets:
//
//   ceiling  — the operator's own monthly budget. Funds free-tier work and the
//              operator's own audits. Resets each calendar month.
//   credit   — a specific customer payment. Funds exactly the work that payment
//              was for, and cannot be overdrawn by anyone else's request.
//
// reserve() is a pre-flight guess; settle() records what actually happened from
// the provider's own usage numbers. The guess only has to be good enough to
// refuse an obviously unaffordable call — it is never billed from.
import { randomUUID } from 'node:crypto';
import { insert } from '../db.js';

/**
 * USD per 1M tokens, from the provider's own pricing page (verified 2026-09-10).
 * Model IDs churn fast — `gpt-5.4` did not survive contact with reality — so
 * these are defaults, overridable from config, and an unknown model is a hard
 * error rather than a silent zero.
 */
export const DEFAULT_PRICING = {
  'gpt-5.6-sol': { in: 4.0, out: 20.0 },
  'gpt-5.6-terra': { in: 2.0, out: 12.0 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2 },
  // Gemini's free tier costs nothing but is quota-limited, so it is priced at
  // zero and bounded by the provider's own quota, not by this ledger.
  'gemini-2.5-flash': { in: 0, out: 0 },
  'gemini-3.7-flash': { in: 0, out: 0 },
};

/** Rough, and deliberately so — see the note above reserve(). */
export const estimateTokens = ({ chars = 0, images = 0, imageTokens = 800 }) =>
  Math.ceil(chars / 4) + images * imageTokens;

/**
 * The ceiling, from the environment or config. One resolver so the number the
 * Settings tab writes is the number that actually stops a call — a spending
 * control that is only read in one of two places is not a control.
 */
export const ceilingFromConfig = (ai = {}) =>
  Number(process.env.AI_MONTHLY_CEILING_USD ?? ai.monthlyCeilingUsd ?? 24);

export class BudgetExceededError extends Error {
  constructor(message, { needUsd, haveUsd, bucket }) {
    super(message);
    this.name = 'BudgetExceededError';
    this.needUsd = needUsd;
    this.haveUsd = haveUsd;
    this.bucket = bucket;
  }
}

export function priceFor(model, pricing = DEFAULT_PRICING) {
  const p = pricing[model];
  if (!p) {
    throw new Error(
      `No price known for model "${model}". Add it to ai.pricing in config.json — ` +
        'guessing a price is how a budget ceiling silently stops working.'
    );
  }
  return p;
}

export const costUsd = ({ model, inputTokens = 0, outputTokens = 0 }, pricing = DEFAULT_PRICING) => {
  const p = priceFor(model, pricing);
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
};

/**
 * @param ceilingUsd the operator's own monthly limit. Default is deliberately
 *   small: this project's whole operating budget is a couple of thousand rupees.
 */
export function createBudget({ db, ceilingUsd = 24, pricing = DEFAULT_PRICING, now = () => new Date() } = {}) {
  const monthStart = () => {
    const d = now();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  };

  /** Operator-funded spend this calendar month (credit-funded spend excluded —
   *  that money was collected for the purpose and is not the operator's). */
  const spentThisMonth = () =>
    db.prepare('SELECT COALESCE(SUM(costUsd), 0) AS n FROM ai_spend WHERE ts >= ? AND creditId IS NULL')
      .get(monthStart()).n;

  const ceilingRemaining = () => Math.max(0, ceilingUsd - spentThisMonth());

  const getCredit = (creditId) => db.prepare('SELECT * FROM credits WHERE id = ?').get(creditId) ?? null;

  const creditRemaining = (creditId) => {
    const c = getCredit(creditId);
    return c ? Math.max(0, c.amountUsd - (c.spentUsd ?? 0)) : 0;
  };

  const remaining = (creditId = null) => (creditId ? creditRemaining(creditId) : ceilingRemaining());

  const canAfford = (estUsd, creditId = null) => remaining(creditId) >= estUsd;

  /**
   * Pre-flight guard. Throws rather than returning false, because every caller
   * would otherwise have to remember to check — and the one that forgets is the
   * one that spends the money.
   */
  function reserve(estUsd, creditId = null) {
    const have = remaining(creditId);
    if (have < estUsd) {
      throw new BudgetExceededError(
        creditId
          ? `Credit ${creditId} has $${have.toFixed(4)} left, needs $${estUsd.toFixed(4)}`
          : `Monthly AI budget exhausted: $${have.toFixed(4)} of $${ceilingUsd} left, needs $${estUsd.toFixed(4)}`,
        { needUsd: estUsd, haveUsd: have, bucket: creditId ? 'credit' : 'ceiling' }
      );
    }
    return { ok: true, remainingUsd: have };
  }

  /** Record what the call actually cost, from the provider's usage numbers. */
  function settle({ provider, model, task, inputTokens = 0, outputTokens = 0, runId = null, creditId = null }) {
    const cost = costUsd({ model, inputTokens, outputTokens }, pricing);
    insert(db, 'ai_spend', {
      id: randomUUID().slice(0, 18), ts: now().toISOString(),
      provider, model, task, inputTokens, outputTokens, costUsd: cost, runId, creditId,
    });
    if (creditId) {
      db.prepare('UPDATE credits SET spentUsd = COALESCE(spentUsd, 0) + ? WHERE id = ?').run(cost, creditId);
    }
    return cost;
  }

  /** A customer payment arriving. This is what makes paid analysis affordable. */
  function addCredit({ customerId = null, source, amountUsd, ref = null }) {
    const id = randomUUID().slice(0, 18);
    insert(db, 'credits', {
      id, customerId, source, amountUsd, spentUsd: 0, createdAt: now().toISOString(), ref,
    });
    return id;
  }

  return {
    ceilingUsd,
    spentThisMonth,
    remaining,
    canAfford,
    reserve,
    settle,
    addCredit,
    getCredit,
    estimate: (args) => costUsd(args, pricing),
    stats: () => ({
      ceilingUsd,
      spentThisMonthUsd: Number(spentThisMonth().toFixed(4)),
      remainingUsd: Number(ceilingRemaining().toFixed(4)),
    }),
  };
}

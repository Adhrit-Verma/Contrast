// Which model answers, and whether it is allowed to.
//
// Pipeline code asks for an assessment; it never names a vendor (decision #21).
// That matters because the vendor has already changed once and the model IDs
// changed again during the build.
//
// Two rules this file exists to enforce, both of which are the kind that fail
// silently and expensively if left to each call site:
//
//   1. A paid model serves a paid entitlement ONLY. A free scan can never reach
//      OpenAI — not when Gemini is down, not when the budget is healthy, not
//      ever. This is a spending boundary, in the same family as the SSRF guard.
//   2. Degrade, never go dark (decision #18). paid → free → deterministic-only,
//      and the caller is told which happened so the report can say so.
import { createOpenAI } from './openai.js';
import { createGemini } from './gemini.js';
import { BudgetExceededError, estimateTokens } from './budget.js';

export const PAID = 'paid';
export const FREE = 'free';

/** What the caller gets when no model could run. Not an error — a deterministic
 *  scan is still a real report, it just checked less and must say so. */
const deterministic = (reason) => ({ ok: false, degraded: 'deterministic', reason, data: null });

export function createProvider({
  ai = {}, db = null, budget = null, log = console.log,
  openai = null, gemini = null, defaultEntitlement = FREE,
} = {}) {
  // Built once per run, like the clients they wrap.
  const paidClient = openai ?? createOpenAI({ ai, db, log });
  const freeClient = gemini ?? createGemini({ ai, db, log });

  /**
   * @param entitlement PAID or FREE — supplied by the caller from the customer
   *   record or the absence of one. Never inferred here.
   * @param creditId    when the work is funded by a specific payment, so the
   *   spend is drawn from that payment and not the operator's ceiling.
   * @returns {Promise<{ok:true,data,provider,model,cached,costUsd}|{ok:false,degraded,reason,data:null}>}
   */
  async function assess({
    task, prompt, schema, images = [], inlineImages = [],
    entitlement = FREE, creditId = null, runId = null, model = null,
  }) {
    const attempt = [];

    if (entitlement === PAID) {
      if (!paidClient.available) {
        attempt.push('openai: no API key');
      } else {
        const useModel = model ?? paidClient.model;
        try {
          // Inside the try on purpose: an unpriced model throws here, and
          // decision #18 says an unrunnable paid path degrades to the free one
          // rather than taking the whole assessment down with it.
          //
          // A guess, only good enough to refuse an obviously unaffordable call.
          // The real number comes back with the response and is what gets billed.
          const estTokens = estimateTokens({
            chars: prompt.length,
            images: images.length + inlineImages.length,
          });
          const estUsd = budget ? budget.estimate({ model: useModel, inputTokens: estTokens, outputTokens: 1500 }) : 0;
          if (budget) budget.reserve(estUsd, creditId);
          const res = await paidClient.generate({ task, prompt, schema, images, inlineImages, model: useModel });
          // Settle from the provider's own usage, never from the estimate.
          const costUsd = budget && res.usage
            ? budget.settle({
                provider: 'openai', model: useModel, task,
                inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
                runId, creditId,
              })
            : 0;
          return { ok: true, data: res.data, provider: 'openai', model: useModel, cached: res.cached, costUsd };
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            log(`    budget: ${err.message} — falling back to the free tier`);
            attempt.push(`openai: ${err.message}`);
          } else {
            log(`    openai failed (${err.message}) — falling back to the free tier`);
            attempt.push(`openai: ${err.message}`);
          }
        }
      }
    }

    // Free tier. Reached either because the caller is a free user, or because
    // the paid path above could not run. Costs no money; bounded by the
    // provider's own quota, which is why there is no budget check here.
    if (!freeClient.available) {
      return deterministic([...attempt, 'gemini: no API key'].join('; '));
    }
    try {
      const res = await freeClient.generate({ task, prompt, schema, images, inlineImages });
      return { ok: true, data: res.data, provider: 'gemini', model: freeClient.model, cached: res.cached, costUsd: 0 };
    } catch (err) {
      return deterministic([...attempt, `gemini: ${err.message}`].join('; '));
    }
  }

  /** What this run can currently do — for the banner the report shows. */
  function mode(entitlement = FREE) {
    if (entitlement === PAID && paidClient.available && (!budget || budget.remaining() > 0)) return PAID;
    if (freeClient.available) return FREE;
    return 'deterministic';
  }

  /**
   * Drop-in replacement for a raw client's generate(), so `assessPage()` and
   * anything else built against the Gemini shape can route through here without
   * knowing it. Throws when nothing could run — the callers already catch that
   * and escalate to `review_queue`, which is exactly the right outcome: the
   * page is recorded as unassessed rather than silently passing.
   */
  async function generate({ task, prompt, schema, images = [], inlineImages = [], entitlement = defaultEntitlement, creditId = null, runId = null, model = null }) {
    const res = await assess({ task, prompt, schema, images, inlineImages, entitlement, creditId, runId, model });
    if (!res.ok) throw new Error(`no AI available for ${task}: ${res.reason}`);
    return { data: res.data, cached: res.cached, provider: res.provider, costUsd: res.costUsd };
  }

  return {
    assess,
    generate,
    mode,
    // Describes the routing rather than one vendor, for the log lines that
    // used to print a single model name.
    get model() {
      const paid = paidClient.available ? paidClient.model : null;
      const free = freeClient.available ? freeClient.model : null;
      return [paid && `${paid} (paid)`, free && `${free} (free)`].filter(Boolean).join(' → ') || 'none';
    },
    available: paidClient.available || freeClient.available,
    paidAvailable: paidClient.available,
    freeAvailable: freeClient.available,
    stats: () => ({
      openai: paidClient.available ? paidClient.stats() : null,
      gemini: freeClient.available ? freeClient.stats() : null,
      budget: budget?.stats() ?? null,
    }),
  };
}

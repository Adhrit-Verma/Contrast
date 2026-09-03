// Global Gemini request discipline: one sequential queue, token bucket, daily
// cap, exponential backoff with jitter. Every AI call in the system goes
// through one instance of this — including from inside the LangGraph nodes.
// now/sleep/random are injectable so the tests do not take real minutes.

export const isRateLimit = (err) =>
  err?.status === 429 ||
  err?.response?.status === 429 ||
  /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(err?.message ?? '');

// A dropped connection or a 503 is exactly as recoverable as a 429 — the
// pipeline should not surface a real audit failure for something that would
// have worked on the next attempt. Genuine client-side errors (bad request,
// invalid schema, missing key) are never in this set, so they still fail fast.
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const TRANSIENT_PATTERN = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up|network (error|timeout)/i;

export const isTransient = (err) => {
  const status = err?.status ?? err?.response?.status;
  if (status && TRANSIENT_STATUS.has(status)) return true;
  return isRateLimit(err) || TRANSIENT_PATTERN.test(err?.message ?? '');
};

export function createLimiter({
  rpm = 15,
  // Burst 1 = pure pacing. A quota of "15 RPM" is enforced over a rolling
  // minute, so a burst of 15 followed by paced calls still trips it. Raise this
  // only on a paid tier where the burst is genuinely allowed.
  burst = 1,
  dailyCap = 1000,
  maxRetries = 5,
  baseDelayMs = 1000,
  maxDelayMs = 60000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  onWait = () => {},
} = {}) {
  const msPerToken = 60000 / rpm;
  const capacity = Math.max(1, burst);
  let tokens = capacity;
  let last = now();
  let used = 0;
  let dayStart = now();
  let chain = Promise.resolve();

  async function take() {
    for (;;) {
      const t = now();
      tokens = Math.min(capacity, tokens + (t - last) / msPerToken);
      last = t;
      if (t - dayStart >= 86400000) {
        used = 0;
        dayStart = t;
      }
      if (used >= dailyCap) throw new Error(`Gemini daily cap reached (${dailyCap} requests) — resume tomorrow or raise ai.dailyCap`);
      if (tokens >= 1) {
        tokens -= 1;
        used += 1;
        return;
      }
      const wait = Math.ceil((1 - tokens) * msPerToken);
      onWait(wait);
      await sleep(wait);
    }
  }

  /** Runs fn strictly after every previously scheduled call. Never Promise.all. */
  function schedule(fn, label = 'gemini') {
    const run = chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await take();
        try {
          return await fn();
        } catch (err) {
          if (!isTransient(err) || attempt >= maxRetries) throw err;
          const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
          const delay = Math.round(backoff * (0.5 + random() * 0.5)); // full-ish jitter
          const why = isRateLimit(err) ? '429' : err?.status ?? err?.response?.status ?? 'network error';
          onWait(delay, `${label} ${why}, retry ${attempt + 1}/${maxRetries}`);
          await sleep(delay);
        }
      }
    });
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  return { schedule, stats: () => ({ used, dailyCap, tokens: Math.floor(tokens), rpm }) };
}

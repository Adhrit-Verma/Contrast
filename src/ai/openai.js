// The only place that talks to OpenAI. Deliberately mirrors createGemini()'s
// shape so src/ai/provider.js can swap one for the other without any caller
// knowing which one answered.
//
// No SDK. Node 22 has fetch, the Responses API is one POST, and this codebase
// already prefers node:sqlite over an ORM and node --test over a framework.
// A dependency here would buy retries and typing we already have in limiter.js
// and validate.js.
//
// NOT YET VERIFIED AGAINST A LIVE KEY. No OPENAI_API_KEY exists in the
// development environment, so the response parsing below is written defensively
// against both documented shapes rather than pinned to one observed reply. Run
// `node src/cli.js probe-openai` once a key exists — see decision #20: this
// codebase does not call something working until it has been run.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createLimiter } from './limiter.js';
import { validate, parseJson } from './validate.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const API = 'https://api.openai.com/v1/responses';

/** Same guard as the Gemini path, same reason: one runaway retry loop billing
 *  real money is the failure that a daily cap alone would not stop in time. */
export function checkPerRunCap(callsSoFar, cap) {
  if (callsSoFar >= cap) {
    throw new Error(`OpenAI per-run cap reached (${cap} requests this run) — raise ai.perRunCap or narrow the scan`);
  }
}

/** OpenAI's strict mode requires every property listed in `required` and
 *  additionalProperties:false at every level. Our schemas are written for
 *  Gemini, which wants neither, so translate rather than maintain two copies. */
export function toOpenAISchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toOpenAISchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toOpenAISchema(v)])
    );
    // strict mode: every key must be required, so optional fields become
    // nullable instead — the same information, expressed the way it wants.
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
  }
  return out;
}

/** The reply text lives in different places depending on which response shape
 *  comes back. Try the convenience field, then walk the output array. */
export function extractText(body) {
  if (typeof body?.output_text === 'string' && body.output_text) return body.output_text;
  const parts = [];
  for (const item of body?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  if (parts.length) return parts.join('');
  // Chat-completions shape, in case the endpoint or account routes that way.
  const legacy = body?.choices?.[0]?.message?.content;
  if (typeof legacy === 'string') return legacy;
  throw new Error(`OpenAI returned no text content (keys: ${Object.keys(body ?? {}).join(', ')})`);
}

/** Usage drives the budget ledger, so an unreadable usage block is an error,
 *  not a zero — a silent zero would make every call look free. */
export function extractUsage(body) {
  const u = body?.usage ?? {};
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  if (input == null || output == null) {
    throw new Error(`OpenAI response had no readable token usage (got: ${JSON.stringify(u)})`);
  }
  return { inputTokens: input, outputTokens: output };
}

const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

export function createOpenAI({ ai = {}, db = null, log = console.log, fetchImpl = fetch } = {}) {
  const apiKey = process.env.OPENAI_API_KEY ?? null;
  // Model IDs churn — gpt-5.4 was current when this was planned and gone by the
  // time it was built. Never hardcode one; config decides, this is the fallback.
  const model = ai.openaiModel ?? 'gpt-5.6-luna';

  const limiter = createLimiter({
    rpm: ai.rpm ?? 15,
    burst: ai.burst ?? 1,
    dailyCap: ai.dailyCap ?? 1000,
    maxRetries: ai.maxRetries ?? 5,
    onWait: (ms, why) => why && log(`    openai: ${why}, waiting ${ms}ms`),
  });

  const counters = { calls: 0, cacheHits: 0, repairs: 0, inputTokens: 0, outputTokens: 0 };

  const cacheGet = (hash) => db?.prepare('SELECT response FROM ai_cache WHERE hash = ?').get(hash)?.response ?? null;
  const cachePut = (hash, task, response) =>
    db
      ?.prepare('INSERT OR REPLACE INTO ai_cache (hash, task, model, response, createdAt) VALUES (?,?,?,?,?)')
      .run(hash, task, model, JSON.stringify(response), new Date().toISOString());

  /**
   * @returns {Promise<{data:any, cached:boolean, usage:{inputTokens,outputTokens}|null}>}
   * `usage` is null on a cache hit — nothing was spent, so nothing to settle.
   */
  async function generate({
    task, prompt, schema, images = [], inlineImages = [],
    temperature = ai.temperature ?? 0.2, model: modelOverride = null,
  }) {
    const useModel = modelOverride ?? model;
    const shots = images.filter((p) => p && existsSync(p));
    const hash = sha(
      [useModel, task, prompt, JSON.stringify(schema), ...shots.map((p) => sha(readFileSync(p))), ...inlineImages.map((i) => sha(i.data))].join('|')
    );

    const hit = cacheGet(hash);
    if (hit) {
      counters.cacheHits++;
      return { data: JSON.parse(hit), cached: true, usage: null };
    }
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set — AI assessment unavailable');

    let feedback = '';
    let lastUsage = null;
    for (let attempt = 0; attempt <= (ai.maxRepairs ?? 2); attempt++) {
      // ponytail: screenshots are sent at whatever size they were captured.
      // Downscaling to ~1024px long edge is the biggest single cost lever if
      // image spend ever matters — it needs an image library, which is not
      // worth a dependency while luna costs $0.20/1M input.
      const content = [
        { type: 'input_text', text: prompt + feedback },
        ...shots.map((p) => ({ type: 'input_image', image_url: dataUrl(readFileSync(p)) })),
        ...inlineImages.map((i) => ({
          type: 'input_image',
          image_url: `data:${i.mimeType ?? 'image/png'};base64,${i.data}`,
        })),
      ];

      const body = {
        model: useModel,
        input: [{ type: 'message', role: 'user', content }],
        temperature,
        ...(schema
          ? { text: { format: { type: 'json_schema', name: task.replace(/[^\w]/g, '_'), schema: toOpenAISchema(schema), strict: true } } }
          : {}),
      };

      const text = await limiter.schedule(async () => {
        checkPerRunCap(counters.calls, ai.perRunCap ?? Infinity);
        counters.calls++;
        const res = await fetchImpl(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          // Let the limiter's own backoff see the status it understands.
          const err = new Error(`OpenAI ${res.status}: ${detail.slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        const json = await res.json();
        lastUsage = extractUsage(json);
        counters.inputTokens += lastUsage.inputTokens;
        counters.outputTokens += lastUsage.outputTokens;
        return extractText(json);
      }, task);

      let data;
      try {
        data = parseJson(text);
      } catch (err) {
        feedback = `\n\nYour previous reply was not valid JSON (${err.message}). Reply with JSON only.`;
        counters.repairs++;
        continue;
      }
      const errs = validate(data, schema);
      if (errs.length === 0) {
        cachePut(hash, task, data);
        return { data, cached: false, usage: lastUsage };
      }
      feedback = `\n\nYour previous reply failed schema validation: ${errs.join('; ')}. Fix exactly those fields.`;
      counters.repairs++;
    }
    throw new Error(`${task}: model produced invalid output after ${(ai.maxRepairs ?? 2) + 1} attempts`);
  }

  return {
    provider: 'openai',
    generate,
    model,
    available: !!apiKey,
    limiter,
    visionAvailable: true, // every current OpenAI model takes image input
    embeddingsAvailable: false, // embeddings stay on Gemini; nothing needs them here
    embed: async () => {
      throw new Error('Embeddings are served by the Gemini path — see src/ai/knowledge.js');
    },
    stats: () => ({ ...counters, ...limiter.stats() }),
  };
}

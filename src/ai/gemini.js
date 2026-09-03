// The only place that talks to Gemini. Everything goes through the limiter and
// the content-hash cache — including calls made from LangGraph nodes in Phase 7.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createLimiter } from './limiter.js';
import { validate, parseJson } from './validate.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Pulled out so the money-path guard is testable without mocking the SDK. */
export function checkPerRunCap(callsSoFar, cap) {
  if (callsSoFar >= cap) {
    throw new Error(`Gemini per-run cap reached (${cap} requests this run) — raise ai.perRunCap or narrow the scan`);
  }
}

/** Gemini wants format:'enum' alongside enum, and rejects unknown keywords. */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.nullable) out.nullable = true;
  if (schema.enum) {
    out.enum = schema.enum;
    out.format = 'enum';
  }
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (schema.required) out.required = schema.required;
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

export function createGemini({ ai = {}, db = null, log = console.log } = {}) {
  const apiKey = process.env.GEMINI_API_KEY ?? null;
  const model = ai.model ?? 'gemini-2.5-flash';

  if (ai.tier !== 'paid') {
    log(
      '\n  !! Gemini tier is "%s". Google may use free-tier prompts for training.\n' +
        '     DO NOT scan client data on the free tier — set ai.tier="paid" and use a billed key.\n',
      ai.tier ?? 'free'
    );
  }

  const client = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  const limiter = createLimiter({
    rpm: ai.rpm ?? 15,
    burst: ai.burst ?? 1,
    dailyCap: ai.dailyCap ?? 1000,
    maxRetries: ai.maxRetries ?? 5,
    onWait: (ms, why) => why && log(`    gemini: ${why}, waiting ${ms}ms`),
  });

  const counters = { calls: 0, cacheHits: 0, repairs: 0 };

  const cacheGet = (hash) => db?.prepare('SELECT response FROM ai_cache WHERE hash = ?').get(hash)?.response ?? null;
  const cachePut = (hash, task, response) =>
    db
      ?.prepare('INSERT OR REPLACE INTO ai_cache (hash, task, model, response, createdAt) VALUES (?,?,?,?,?)')
      .run(hash, task, model, JSON.stringify(response), new Date().toISOString());

  const imagePart = (path) => ({
    inlineData: { mimeType: 'image/png', data: readFileSync(path).toString('base64') },
  });

  /**
   * @returns {Promise<{data: any, cached: boolean}>}
   * Throws when the key is missing or the model will not produce valid output —
   * callers escalate to a human rather than inventing an answer.
   */
  async function generate({ task, prompt, schema, images = [], inlineImages = [], temperature = ai.temperature ?? 0.2 }) {
    const shots = images.filter((p) => p && existsSync(p));
    const hash = sha(
      [model, task, prompt, JSON.stringify(schema), ...shots.map((p) => sha(readFileSync(p))), ...inlineImages.map((i) => sha(i.data))].join('|')
    );

    const hit = cacheGet(hash);
    if (hit) {
      counters.cacheHits++;
      return { data: JSON.parse(hit), cached: true };
    }
    if (!client) throw new Error('GEMINI_API_KEY is not set — AI assessment unavailable');

    const gm = client.getGenerativeModel({
      model,
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema: toGeminiSchema(schema) } : {}),
      },
    });

    let feedback = '';
    for (let attempt = 0; attempt <= (ai.maxRepairs ?? 2); attempt++) {
      const parts = [
        { text: prompt + feedback },
        ...shots.map(imagePart),
        // Images we already hold in memory (the capability probe), not on disk.
        ...inlineImages.map((i) => ({ inlineData: { mimeType: i.mimeType ?? 'image/png', data: i.data } })),
      ];
      const text = await limiter.schedule(async () => {
        // One createGemini() instance lives for exactly one audit run (assess,
        // run --scope=assess/full, or the graph). A bug in a retry loop burning
        // an unbounded number of real, billed calls is the actual "public tool
        // with no cap" risk — the daily cap alone would not stop it same-day.
        checkPerRunCap(counters.calls, ai.perRunCap ?? Infinity);
        counters.calls++;
        const res = await gm.generateContent({ contents: [{ role: 'user', parts }] });
        return res.response.text();
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
        return { data, cached: false };
      }
      feedback = `\n\nYour previous reply failed schema validation: ${errs.join('; ')}. Fix exactly those fields.`;
      counters.repairs++;
    }
    throw new Error(`${task}: model produced invalid output after ${(ai.maxRepairs ?? 2) + 1} attempts`);
  }

  async function embed(texts, embedModel = ai.embedModel ?? 'text-embedding-004') {
    if (!client) throw new Error('GEMINI_API_KEY is not set — embeddings unavailable');
    const gm = client.getGenerativeModel({ model: embedModel });
    const out = [];
    for (const text of texts) {
      // Batched by the caller in chunks; still one queued request each.
      const res = await limiter.schedule(() => gm.embedContent(text), 'embed');
      out.push(res.embedding.values);
    }
    return out;
  }

  return {
    generate, embed, model, available: !!client, limiter,
    // Set by capability detection; undefined means "not probed, assume yes".
    embeddingsAvailable: ai.capabilities?.embeddings,
    visionAvailable: ai.capabilities?.vision,
    stats: () => ({ ...counters, ...limiter.stats() }),
  };
}

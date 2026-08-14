// Work out what this API key can actually do, and configure the tool for it.
//
// Model names churn constantly — "gemini-2.5-flash is no longer available to
// new users" is a real error a real key hits. So nothing here hardcodes a
// model: we ask the API what it will serve, rank the candidates, probe the top
// few, and write the winner into config. The auditor never picks a model.
import { createGemini } from './gemini.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

/** A 1x1 PNG. Enough to prove a model accepts image parts, and costs almost nothing. */
export const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Every model this key may use, following pagination. */
export async function listModels(apiKey, fetchImpl = fetch) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const res = await fetchImpl(`${API}/models?key=${encodeURIComponent(apiKey)}&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`could not list models (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    out.push(...(data.models ?? []));
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return out;
}

const bare = (name) => String(name ?? '').replace(/^models\//, '');

// Families we must never pick for the generation tasks.
const NOT_A_CHAT_MODEL = /embedding|aqa|imagen|veo|image-generation|tts|audio|native-audio|live|learnlm/i;

/**
 * Score a generateContent model for this pipeline. Order of preference:
 * newest major version, then flash (the cost/latency sweet spot for tens of
 * thousands of small judgment calls), then stable over preview — a compliance
 * tool should not sit on an experimental endpoint by default.
 */
export function scoreModel(model) {
  const name = bare(model.name);
  if (!(model.supportedGenerationMethods ?? []).includes('generateContent')) return -1;
  if (NOT_A_CHAT_MODEL.test(name)) return -1;

  const version = Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);
  const family = /flash-lite/.test(name) ? 20 : /flash/.test(name) ? 30 : /pro/.test(name) ? 10 : 0;
  const stable = /preview|exp|experimental|latest/.test(name) ? 0 : 15;
  const dated = /-\d{3,}$/.test(name) ? -2 : 0; // prefer the rolling alias over a pinned date
  return version * 100 + family + stable + dated;
}

export function rankModels(models) {
  return models
    .map((m) => ({ name: bare(m.name), score: scoreModel(m), inputTokenLimit: m.inputTokenLimit, methods: m.supportedGenerationMethods ?? [] }))
    .filter((m) => m.score >= 0)
    .sort((a, b) => b.score - a.score);
}

export function rankEmbedModels(models) {
  return models
    .map((m) => ({ name: bare(m.name), methods: m.supportedGenerationMethods ?? [] }))
    .filter((m) => m.methods.includes('embedContent'))
    .sort((a, b) => embedScore(b.name) - embedScore(a.name));
}

const embedScore = (n) => (/gemini-embedding/.test(n) ? 30 : /text-embedding-\d+/.test(n) ? 20 : 10) + (/exp|preview/.test(n) ? 0 : 5);

const PROBE_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' }, saw: { type: 'string' } },
};

/** One model, the two things the pipeline needs from it. */
async function probeModel(ai, model, log) {
  const gemini = createGemini({ ai: { ...ai, model, maxRepairs: 0 }, db: null, log: () => {} });
  const result = { model, json: false, vision: false, error: null };
  try {
    const { data } = await gemini.generate({
      task: 'probe-json',
      prompt: 'Reply with {"ok": true} and nothing else.',
      schema: PROBE_SCHEMA,
    });
    result.json = data.ok === true;
  } catch (err) {
    result.error = err.message;
    return result;
  }
  try {
    const { data } = await gemini.generate({
      task: 'probe-vision',
      prompt: 'An image is attached. Reply with {"ok": true, "saw": "<one word describing it>"}.',
      schema: PROBE_SCHEMA,
      inlineImages: [{ mimeType: 'image/png', data: PIXEL_PNG }],
    });
    result.vision = data.ok === true;
  } catch (err) {
    result.visionError = err.message;
  }
  return result;
}

async function probeEmbedding(ai, model) {
  const gemini = createGemini({ ai: { ...ai, embedModel: model }, db: null, log: () => {} });
  try {
    const [vec] = await gemini.embed(['accessibility']);
    return { ok: Array.isArray(vec) && vec.length > 0, dimensions: vec?.length ?? 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The whole detection run. Costs a handful of requests, never more than
 * `maxCandidates` models deep, and returns everything the UI needs to explain
 * itself — including which models it tried and why it moved on.
 * @returns {Promise<{ok:boolean, model:string|null, embedModel:string|null, capabilities:object[], tried:object[], available:number}>}
 */
export async function detectSetup({ ai = {}, apiKey = process.env.GEMINI_API_KEY, maxCandidates = 3, log = () => {} } = {}) {
  const cap = (name, status, detail) => ({ name, status, detail });
  if (!apiKey) {
    return { ok: false, model: null, embedModel: null, tried: [], available: 0, capabilities: [cap('API key', 'fail', 'no key saved')] };
  }

  let models;
  try {
    models = await listModels(apiKey);
  } catch (err) {
    const auth = /401|403|API_KEY|PERMISSION/i.test(err.message);
    return {
      ok: false, model: null, embedModel: null, tried: [], available: 0,
      capabilities: [cap('API key', auth ? 'fail' : 'pass', err.message)],
    };
  }

  const candidates = rankModels(models);
  const embedCandidates = rankEmbedModels(models);
  log(`  ${models.length} models visible to this key, ${candidates.length} usable for generation`);

  const tried = [];
  let chosen = null;
  for (const c of candidates.slice(0, maxCandidates)) {
    log(`  probing ${c.name}…`);
    const r = await probeModel(ai, c.name, log);
    tried.push(r);
    if (r.json) { chosen = r; break; }
  }

  let embed = null;
  for (const e of embedCandidates.slice(0, 2)) {
    const r = await probeEmbedding(ai, e.name);
    if (r.ok) { embed = { model: e.name, ...r }; break; }
  }

  const capabilities = [
    cap('API key', 'pass', `${models.length} models available`),
    cap('Model', chosen ? 'pass' : 'fail', chosen ? chosen.model : `none of ${tried.length} candidates answered`),
    cap('Structured JSON output', chosen?.json ? 'pass' : 'fail', chosen?.json ? 'schema honoured' : tried[0]?.error ?? 'not available'),
    cap('Vision — alt-text quality', chosen?.vision ? 'pass' : 'fail', chosen?.vision ? 'accepts inline images' : chosen?.visionError ?? 'model rejected an image part'),
    cap('Embeddings — knowledge base', embed ? 'pass' : 'fail', embed ? `${embed.model} (${embed.dimensions}d)` : 'no embedding model — the knowledge base falls back to keyword search'),
  ];

  return {
    ok: !!chosen,
    model: chosen?.model ?? null,
    embedModel: embed?.model ?? null,
    capabilities,
    tried,
    available: models.length,
    features: {
      json: !!chosen?.json,
      vision: !!chosen?.vision,
      embeddings: !!embed,
    },
  };
}

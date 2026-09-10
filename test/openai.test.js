import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createOpenAI, toOpenAISchema, extractText, extractUsage, checkPerRunCap } from '../src/ai/openai.js';

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
  required: ['verdict'],
};

/** A fetch stand-in — no network, no key, no spend. */
const fakeFetch = (replies) => {
  const calls = [];
  let i = 0;
  const impl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const r = replies[Math.min(i++, replies.length - 1)];
    return {
      ok: r.ok !== false,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
};

const okReply = (obj, usage = { input_tokens: 100, output_tokens: 20 }) => ({
  body: { output_text: JSON.stringify(obj), usage },
});

/** Must await the callback before closing — a sync finally would shut the
 *  database while the generate() promise is still using it. */
async function withDb(fn) {
  const path = `runs/__test-openai-${randomUUID()}.sqlite`;
  const db = openDb(path);
  try { return await fn(db); } finally {
    db.close();
    for (const s of ['', '-wal', '-shm']) rmSync(path + s, { force: true });
  }
}

test('toOpenAISchema makes every property required and closes the object', () => {
  const out = toOpenAISchema(SCHEMA);
  // strict mode demands both, and our source schemas provide neither.
  assert.deepEqual(out.required.sort(), ['confidence', 'verdict']);
  assert.equal(out.additionalProperties, false);
});

test('toOpenAISchema recurses into arrays and nested objects', () => {
  const out = toOpenAISchema({
    type: 'object',
    properties: { findings: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } },
  });
  assert.equal(out.properties.findings.items.additionalProperties, false);
  assert.deepEqual(out.properties.findings.items.required, ['a']);
});

test('extractText handles the convenience field, the output array, and the legacy shape', () => {
  assert.equal(extractText({ output_text: 'hi' }), 'hi');
  assert.equal(extractText({ output: [{ content: [{ text: 'a' }, { text: 'b' }] }] }), 'ab');
  assert.equal(extractText({ choices: [{ message: { content: 'legacy' } }] }), 'legacy');
});

test('extractText throws rather than returning empty when there is no content', () => {
  assert.throws(() => extractText({ id: 'resp_1' }), /no text content/);
});

test('extractUsage reads both field namings, and refuses to invent a zero', () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 5, output_tokens: 7 } }), { inputTokens: 5, outputTokens: 7 });
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 7 } }), { inputTokens: 5, outputTokens: 7 });
  // A silent zero would make every call look free to the budget ledger.
  assert.throws(() => extractUsage({ usage: {} }), /no readable token usage/);
});

test('per-run cap stops a runaway loop', () => {
  assert.doesNotThrow(() => checkPerRunCap(4, 5));
  assert.throws(() => checkPerRunCap(5, 5), /per-run cap reached/);
});

test('generate returns parsed data plus the usage the budget ledger needs', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([okReply({ verdict: 'ok', confidence: 0.9 })]);
    const client = createOpenAI({ ai: {}, db, log: () => {}, fetchImpl });
    const res = await client.generate({ task: 'alt-text', prompt: 'p', schema: SCHEMA });
    assert.deepEqual(res.data, { verdict: 'ok', confidence: 0.9 });
    assert.equal(res.cached, false);
    assert.deepEqual(res.usage, { inputTokens: 100, outputTokens: 20 });
  });
  delete process.env.OPENAI_API_KEY;
});

test('a second identical call is served from cache and spends nothing', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([okReply({ verdict: 'ok' })]);
    const client = createOpenAI({ ai: {}, db, log: () => {}, fetchImpl });
    await client.generate({ task: 't', prompt: 'same', schema: SCHEMA });
    const second = await client.generate({ task: 't', prompt: 'same', schema: SCHEMA });
    assert.equal(second.cached, true);
    assert.equal(second.usage, null, 'a cache hit spent nothing, so there is nothing to settle');
    assert.equal(fetchImpl.calls.length, 1, 'the second call must not reach the network');
  });
  delete process.env.OPENAI_API_KEY;
});

test('invalid JSON is repaired, not accepted', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([
      { body: { output_text: 'not json at all', usage: { input_tokens: 1, output_tokens: 1 } } },
      okReply({ verdict: 'recovered' }),
    ]);
    const client = createOpenAI({ ai: {}, db, log: () => {}, fetchImpl });
    const res = await client.generate({ task: 't', prompt: 'p', schema: SCHEMA });
    assert.equal(res.data.verdict, 'recovered');
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[1].body.input[0].content[0].text, /not valid JSON/);
  });
  delete process.env.OPENAI_API_KEY;
});

test('the request carries a strict json_schema and the configured model', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([okReply({ verdict: 'ok' })]);
    const client = createOpenAI({ ai: { openaiModel: 'gpt-5.6-terra' }, db, log: () => {}, fetchImpl });
    await client.generate({ task: 'alt text', prompt: 'p', schema: SCHEMA });
    const sent = fetchImpl.calls[0].body;
    assert.equal(sent.model, 'gpt-5.6-terra');
    assert.equal(sent.text.format.type, 'json_schema');
    assert.equal(sent.text.format.strict, true);
    assert.equal(sent.text.format.name, 'alt_text', 'schema names cannot contain spaces');
  });
  delete process.env.OPENAI_API_KEY;
});

test('a per-call model override beats the configured default', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([okReply({ verdict: 'ok' })]);
    const client = createOpenAI({ ai: { openaiModel: 'gpt-5.6-luna' }, db, log: () => {}, fetchImpl });
    await client.generate({ task: 't', prompt: 'p', schema: SCHEMA, model: 'gpt-5.6-sol' });
    assert.equal(fetchImpl.calls[0].body.model, 'gpt-5.6-sol');
  });
  delete process.env.OPENAI_API_KEY;
});

test('an HTTP error surfaces its status so the limiter can back off', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  await withDb(async (db) => {
    const fetchImpl = fakeFetch([{ ok: false, status: 400, body: { error: 'bad schema' } }]);
    const client = createOpenAI({ ai: { maxRetries: 0 }, db, log: () => {}, fetchImpl });
    await assert.rejects(() => client.generate({ task: 't', prompt: 'p', schema: SCHEMA }), /OpenAI 400/);
  });
  delete process.env.OPENAI_API_KEY;
});

test('no key means a clear error, never a silent skip', async () => {
  delete process.env.OPENAI_API_KEY;
  await withDb(async (db) => {
    const client = createOpenAI({ ai: {}, db, log: () => {}, fetchImpl: fakeFetch([okReply({})]) });
    assert.equal(client.available, false);
    await assert.rejects(() => client.generate({ task: 't', prompt: 'p', schema: SCHEMA }), /OPENAI_API_KEY is not set/);
  });
});

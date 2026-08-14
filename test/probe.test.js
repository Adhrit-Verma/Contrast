// Model names churn — "gemini-2.5-flash is no longer available to new users" is
// a real error a real key hits. The ranking is what protects the auditor from
// ever having to know that, so it gets tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankModels, rankEmbedModels, scoreModel, listModels } from '../src/ai/probe.js';

const gen = ['generateContent'];
const MODELS = [
  { name: 'models/gemini-1.5-flash', supportedGenerationMethods: gen },
  { name: 'models/gemini-2.0-flash', supportedGenerationMethods: gen },
  { name: 'models/gemini-2.5-flash', supportedGenerationMethods: gen },
  { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: gen },
  { name: 'models/gemini-2.5-pro', supportedGenerationMethods: gen },
  { name: 'models/gemini-3.0-flash-preview', supportedGenerationMethods: gen },
  { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/imagen-4.0-generate', supportedGenerationMethods: ['predict'] },
  { name: 'models/veo-3.0', supportedGenerationMethods: ['predictLongRunning'] },
  { name: 'models/gemini-2.5-flash-tts', supportedGenerationMethods: gen },
  { name: 'models/aqa', supportedGenerationMethods: gen },
];

test('only models that can actually generate content are candidates', () => {
  const names = rankModels(MODELS).map((m) => m.name);
  for (const bad of ['imagen-4.0-generate', 'veo-3.0', 'gemini-2.5-flash-tts', 'aqa', 'gemini-embedding-001']) {
    assert.ok(!names.includes(bad), `${bad} must never be picked for generation`);
  }
  assert.ok(names.includes('gemini-2.5-flash'));
});

test('newer versions win, and flash beats pro for a pipeline of small calls', () => {
  const ranked = rankModels(MODELS).map((m) => m.name);
  assert.equal(ranked[0], 'gemini-3.0-flash-preview', 'a newer major version outranks everything older');
  const stable = ranked.filter((n) => !n.includes('preview'));
  assert.equal(stable[0], 'gemini-2.5-flash');
  assert.ok(ranked.indexOf('gemini-2.5-flash') < ranked.indexOf('gemini-2.5-pro'));
  assert.ok(ranked.indexOf('gemini-2.5-flash') < ranked.indexOf('gemini-2.0-flash'));
});

test('stable is preferred over preview at the same version', () => {
  const both = [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: gen },
    { name: 'models/gemini-2.5-flash-preview-09-2025', supportedGenerationMethods: gen },
  ];
  assert.equal(rankModels(both)[0].name, 'gemini-2.5-flash');
  assert.ok(scoreModel({ name: 'models/gemini-2.5-flash', supportedGenerationMethods: gen }) > 0);
  assert.equal(scoreModel({ name: 'models/whatever', supportedGenerationMethods: ['predict'] }), -1);
});

test('embedding models are ranked separately and never mixed in', () => {
  const emb = rankEmbedModels(MODELS).map((m) => m.name);
  assert.deepEqual(emb, ['gemini-embedding-001', 'text-embedding-004']);
  assert.ok(!emb.includes('gemini-2.5-flash'));
});

test('listModels follows pagination and surfaces a bad key clearly', async () => {
  const pages = [
    { models: [{ name: 'models/a', supportedGenerationMethods: gen }], nextPageToken: 't1' },
    { models: [{ name: 'models/b', supportedGenerationMethods: gen }] },
  ];
  let call = 0;
  const fakeFetch = async () => ({ ok: true, json: async () => pages[call++] });
  assert.equal((await listModels('k', fakeFetch)).length, 2);

  const deny = async () => ({ ok: false, status: 403, text: async () => 'API_KEY_INVALID' });
  await assert.rejects(listModels('bad', deny), /could not list models \(403\)/);
});

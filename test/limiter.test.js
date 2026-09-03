import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, isRateLimit, isTransient } from '../src/ai/limiter.js';
import { validate, parseJson } from '../src/ai/validate.js';

/** Virtual clock: sleep() jumps time instead of waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
    get time() { return t; },
  };
}

test('limiter never exceeds RPM in any 60s window', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rpm: 5, now: clock.now, sleep: clock.sleep });
  const stamps = [];
  for (let i = 0; i < 12; i++) await limiter.schedule(async () => stamps.push(clock.time));
  for (const s of stamps) {
    const inWindow = stamps.filter((x) => x >= s && x < s + 60000).length;
    assert.ok(inWindow <= 5, `window at ${s} had ${inWindow} calls`);
  }
});

test('limiter runs calls sequentially — never two in flight', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rpm: 1000, now: clock.now, sleep: clock.sleep });
  let inFlight = 0;
  let maxInFlight = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      limiter.schedule(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
      })
    )
  );
  assert.equal(maxInFlight, 1);
});

test('limiter retries 429 with exponential backoff + jitter, then succeeds', async () => {
  const clock = fakeClock();
  const waits = [];
  const limiter = createLimiter({
    rpm: 1000, baseDelayMs: 1000, now: clock.now, sleep: clock.sleep, random: () => 1,
    onWait: (ms, why) => why && waits.push(ms),
  });
  let calls = 0;
  const result = await limiter.schedule(async () => {
    if (++calls <= 3) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('limiter gives up on 429 after maxRetries and never retries other errors', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rpm: 1000, maxRetries: 2, now: clock.now, sleep: clock.sleep });
  let calls = 0;
  await assert.rejects(limiter.schedule(async () => { calls++; throw Object.assign(new Error('429'), { status: 429 }); }));
  assert.equal(calls, 3); // initial + 2 retries

  let other = 0;
  await assert.rejects(limiter.schedule(async () => { other++; throw new Error('bad request'); }));
  assert.equal(other, 1);
});

test('limiter enforces the daily cap', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rpm: 1000, dailyCap: 3, now: clock.now, sleep: clock.sleep });
  for (let i = 0; i < 3; i++) await limiter.schedule(async () => i);
  await assert.rejects(limiter.schedule(async () => 1), /daily cap/);
  clock.advance(86400001);
  assert.equal(await limiter.schedule(async () => 'new day'), 'new day');
});

test('isRateLimit recognises the shapes Gemini actually throws', () => {
  assert.ok(isRateLimit({ status: 429 }));
  assert.ok(isRateLimit(new Error('[429 Too Many Requests] RESOURCE_EXHAUSTED')));
  assert.ok(!isRateLimit(new Error('400 invalid argument')));
});

test('limiter retries a dropped connection or a 503, not just 429', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ rpm: 1000, baseDelayMs: 500, now: clock.now, sleep: clock.sleep, random: () => 0 });
  let calls = 0;
  const result = await limiter.schedule(async () => {
    if (++calls === 1) throw Object.assign(new Error('service unavailable'), { status: 503 });
    if (calls === 2) throw new Error('fetch failed: ECONNRESET');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('isTransient covers 5xx and network drops, never a genuine client error', () => {
  assert.ok(isTransient({ status: 503 }));
  assert.ok(isTransient(new Error('fetch failed')));
  assert.ok(isTransient(new Error('ECONNRESET')));
  assert.ok(isTransient({ status: 429 }));
  assert.ok(!isTransient(new Error('400 invalid argument')));
  assert.ok(!isTransient({ status: 401 }));
});

const SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'verdict'],
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

test('validate accepts good payloads and names every bad field', () => {
  assert.deepEqual(validate({ items: [{ id: 'a', verdict: 'fail', confidence: 0.8 }] }, SCHEMA), []);
  assert.deepEqual(validate({}, SCHEMA), ['$.items: required']);
  const errs = validate({ items: [{ id: 1, verdict: 'maybe' }] }, SCHEMA);
  assert.equal(errs.length, 2);
  assert.match(errs.join(), /items\[0\]\.id: expected string/);
  assert.match(errs.join(), /not in pass\|fail/);
});

test('parseJson survives fences and surrounding prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here you go: {"a":[1,2]} hope that helps'), { a: [1, 2] });
  assert.throws(() => parseJson('no json here'));
});

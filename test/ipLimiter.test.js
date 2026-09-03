import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpLimiter, createConcurrencyGate } from '../src/public/ipLimiter.js';

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('ipLimiter allows up to max requests per IP per window, then blocks', () => {
  const clock = fakeClock();
  const limiter = createIpLimiter({ max: 3, windowMs: 60000, now: clock.now });
  for (let i = 0; i < 3; i++) assert.equal(limiter.check('1.2.3.4').allowed, true);
  const blocked = limiter.check('1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
});

test('ipLimiter tracks each IP independently', () => {
  const limiter = createIpLimiter({ max: 1 });
  assert.equal(limiter.check('1.1.1.1').allowed, true);
  assert.equal(limiter.check('1.1.1.1').allowed, false);
  assert.equal(limiter.check('2.2.2.2').allowed, true, 'a different visitor is not penalised');
});

test('ipLimiter resets once the window has passed', () => {
  const clock = fakeClock();
  const limiter = createIpLimiter({ max: 1, windowMs: 1000, now: clock.now });
  assert.equal(limiter.check('1.2.3.4').allowed, true);
  assert.equal(limiter.check('1.2.3.4').allowed, false);
  clock.advance(1001);
  assert.equal(limiter.check('1.2.3.4').allowed, true);
});

test('sweep drops stale entries so memory does not grow forever', () => {
  const clock = fakeClock();
  const limiter = createIpLimiter({ max: 1, windowMs: 1000, now: clock.now });
  limiter.check('1.2.3.4');
  assert.equal(limiter.size(), 1);
  clock.advance(2000);
  limiter.sweep();
  assert.equal(limiter.size(), 0);
});

test('concurrency gate caps how many scans run at once, regardless of IP', () => {
  const gate = createConcurrencyGate(2);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), false, 'a third scan must wait');
  gate.release();
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.active(), 2);
});

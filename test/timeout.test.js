// Everything in the pipeline that can hang now has a deadline. This is that
// deadline — an audit that never finishes is worse than one that skips a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/timeout.js';

test('a promise that settles in time passes straight through', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'x'), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});

test('a promise that hangs is abandoned, with the label in the message', async () => {
  // Resolvable, not a true `new Promise(() => {})` — production code abandons
  // it (never awaits it again), but the test settles it once the assertion is
  // done so nothing outlives this test. A permanently-pending promise here
  // left withTimeout's internal .finally() chain dangling forever, which a
  // recent Node patch on CI flags as "still pending after the event loop
  // resolved" and cancels the rest of the file over — a real Node-version
  // difference between this machine and GitHub's runner, not a flaky test.
  let resolveForever;
  const forever = new Promise((resolve) => { resolveForever = resolve; });
  await assert.rejects(withTimeout(forever, 20, 'lighthouse on /slow'), /timed out after 0s: lighthouse on \/slow/);
  resolveForever();
});

test('0 or no budget means no deadline at all', async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 0), 1);
  assert.equal(await withTimeout(Promise.resolve(2), undefined), 2);
});

test('the timer never keeps the process alive after the work finishes', async () => {
  // A pending 10-minute timer would hold the event loop open; unref + clear stop that.
  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  await withTimeout(Promise.resolve('done'), 600000, 'long');
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  assert.ok(after <= before, `left ${after - before} timer(s) behind`);
});

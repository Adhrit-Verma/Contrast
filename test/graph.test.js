// Closes the largest standing coverage gap: src/graph/ had no tests at all
// since 2026-09-04.
//
// The nodes are thin wrappers over phase-1–6 functions that are already tested,
// and exercising them needs a real browser plus a real API key. What was
// genuinely untested — and what LangGraph is actually here for — is the routing:
// the scan loop, the component loop, and the generateFix → verifyFix → retry
// cycle. A wrong comparison in that last one spends real money in a loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { afterScanPage, afterNextComponent, afterVerify, append, appendUnique, replace } from '../src/graph/audit.js';

// ------------------------------------------------------------- the scan loop

test('scanPage loops while pages remain, then moves on exactly once', () => {
  assert.equal(afterScanPage({ pagesQueued: ['a', 'b'] }), 'scanPage');
  assert.equal(afterScanPage({ pagesQueued: ['a'] }), 'scanPage');
  assert.equal(afterScanPage({ pagesQueued: [] }), 'normalize');
});

test('a missing queue does not throw — it ends the loop', () => {
  // The queue is absent on a resumed checkpoint written before this field
  // existed; reading .length off undefined would crash the whole audit.
  assert.equal(afterScanPage({}), 'normalize');
  assert.equal(afterScanPage({ pagesQueued: undefined }), 'normalize');
});

// -------------------------------------------------------- the component loop

test('components are fixed while any remain, then the report is written', () => {
  assert.equal(afterNextComponent({ currentComponent: { id: 'c1' } }), 'retrieveGuidance');
  assert.equal(afterNextComponent({ currentComponent: null }), 'report');
  assert.equal(afterNextComponent({}), 'report');
});

// ------------------------------------------------------------ the retry cycle

test('a verified fix moves to the next component', () => {
  assert.equal(afterVerify({ verificationResult: 'verified', fixAttempts: 0 }, 3), 'nextComponent');
  // Verified wins even at the attempt limit — success is not overridden by
  // having taken a while to get there.
  assert.equal(afterVerify({ verificationResult: 'verified', fixAttempts: 99 }, 3), 'nextComponent');
});

test('an unverified fix retries while attempts remain', () => {
  assert.equal(afterVerify({ verificationResult: 'unresolved', fixAttempts: 0 }, 3), 'generateFix');
  assert.equal(afterVerify({ verificationResult: 'unresolved', fixAttempts: 2 }, 3), 'generateFix');
});

test('the cycle escalates instead of looping forever — the money-burning failure', () => {
  assert.equal(afterVerify({ verificationResult: 'unresolved', fixAttempts: 3 }, 3), 'escalateToHuman');
  assert.equal(afterVerify({ verificationResult: 'regressed', fixAttempts: 4 }, 3), 'escalateToHuman');
  // maxAttempts of 0 must escalate immediately, not run once "for free".
  assert.equal(afterVerify({ verificationResult: 'unresolved', fixAttempts: 0 }, 0), 'escalateToHuman');
});

test('a regressed fix is never treated as success', () => {
  assert.equal(afterVerify({ verificationResult: 'regressed', fixAttempts: 0 }, 3), 'generateFix');
  assert.notEqual(afterVerify({ verificationResult: 'regressed', fixAttempts: 9 }, 3), 'nextComponent');
});

// ---------------------------------------------------------------- reducers

test('append accepts a single value or an array', () => {
  assert.deepEqual(append([1], 2), [1, 2]);
  assert.deepEqual(append([1], [2, 3]), [1, 2, 3]);
  assert.deepEqual(append(undefined, 1), [1]);
});

test('appendUnique is idempotent on id — a resumed checkpoint must not double-count', () => {
  const a = [{ id: 'f1' }, { id: 'f2' }];
  assert.deepEqual(appendUnique(a, { id: 'f1' }).map((x) => x.id), ['f1', 'f2']);
  assert.deepEqual(appendUnique(a, [{ id: 'f2' }, { id: 'f3' }]).map((x) => x.id), ['f1', 'f2', 'f3']);
  // Replaying the whole batch — exactly what a checkpoint resume does — must
  // leave the list unchanged.
  assert.deepEqual(appendUnique(a, a).map((x) => x.id), ['f1', 'f2']);
});

test('appendUnique dedupes within a single incoming batch too', () => {
  assert.deepEqual(appendUnique([], [{ id: 'x' }, { id: 'x' }]).map((v) => v.id), ['x']);
});

test('appendUnique drops nullish entries rather than crashing on .id', () => {
  assert.deepEqual(appendUnique([], [null, { id: 'a' }, undefined]).map((v) => v.id), ['a']);
});

test('replace keeps the old value when the update is undefined', () => {
  // Nodes return partial state; an absent key must not wipe what is there.
  assert.equal(replace('keep', undefined), 'keep');
  assert.equal(replace('old', 'new'), 'new');
  assert.equal(replace('old', null), null, 'an explicit null is a real value');
});

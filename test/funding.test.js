import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingState, GOALS } from '../src/public/funding.js';

const goals = [
  { at: 10, title: 'a', why: '' },
  { at: 50, title: 'b', why: '' },
  { at: 100, title: 'c', why: '' },
];

test('progress runs across the whole ladder, not per-tier', () => {
  assert.equal(fundingState(0, goals).percent, 0);
  assert.equal(fundingState(50, goals).percent, 50);
  assert.equal(fundingState(100, goals).percent, 100);
  assert.equal(fundingState(250, goals).percent, 100, 'never overflows past 100');
});

test('reached tiers are marked, and the next unreached one is named', () => {
  const s = fundingState(60, goals);
  assert.deepEqual(s.goals.map((g) => g.reached), [true, true, false]);
  assert.equal(s.next.title, 'c');
});

test('past the last tier there is no next goal', () => {
  assert.equal(fundingState(500, goals).next, null);
});

test('junk input is treated as zero, never NaN in the bar width', () => {
  for (const bad of [undefined, null, 'abc', -20, NaN]) {
    const s = fundingState(bad, goals);
    assert.equal(s.raised, 0);
    assert.equal(s.percent, 0);
  }
});

test('the shipped goals are ascending — the ladder only makes sense in order', () => {
  const ats = GOALS.map((g) => g.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
});

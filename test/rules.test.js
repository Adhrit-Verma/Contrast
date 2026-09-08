import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesRule } from '../src/public/rules.js';

test('matchesRule: empty rule set never matches', () => {
  assert.equal(matchesRule([], { url: 'https://example.com', title: 'x', status: 200 }), false);
});

test('matchesRule: domain pattern matches by hostname', () => {
  const rules = [{ action: 'treat_as_blocked', patternType: 'domain', pattern: 'indigo.com' }];
  assert.equal(matchesRule(rules, { url: 'https://www.indigo.com/home', title: '' }), true);
  assert.equal(matchesRule(rules, { url: 'https://other.com/home', title: '' }), false);
});

test('matchesRule: content pattern matches against title + url text', () => {
  const rules = [{ action: 'treat_as_blocked', patternType: 'content', pattern: 'akamfailoverpage' }];
  assert.equal(matchesRule(rules, { url: 'https://x.com/akamfailoverpage/logo.svg', title: '' }), true);
  assert.equal(matchesRule(rules, { url: 'https://x.com/home', title: 'Real page' }), false);
});

test('matchesRule: ignores rules whose action is not treat_as_blocked', () => {
  const rules = [{ action: 'something_else', patternType: 'domain', pattern: 'example.com' }];
  assert.equal(matchesRule(rules, { url: 'https://example.com', title: '' }), false);
});

test('matchesRule: a malformed url does not throw', () => {
  const rules = [{ action: 'treat_as_blocked', patternType: 'domain', pattern: 'example.com' }];
  assert.equal(matchesRule(rules, { url: 'not a url', title: '' }), false);
});

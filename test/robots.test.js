import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsAllows } from '../src/browser/robots.js';
import { seal, unseal } from '../src/browser/session.js';
import { randomBytes } from 'node:crypto';

const TXT = `
# comment
Sitemap: https://a.com/sitemap.xml

User-agent: *
Disallow: /admin
Allow: /admin/public

User-agent: a11y-audit-agent
Disallow: /private
`;

test('parseRobots picks the group for our UA, falls back to *', () => {
  assert.deepEqual(parseRobots(TXT, 'a11y-audit-agent').rules, [{ allow: false, path: '/private' }]);
  assert.deepEqual(parseRobots(TXT, 'other-bot').rules, [
    { allow: false, path: '/admin' },
    { allow: true, path: '/admin/public' },
  ]);
  assert.deepEqual(parseRobots(TXT, '*').sitemaps, ['https://a.com/sitemap.xml']);
});

test('robotsAllows: longest match wins, allow breaks ties', () => {
  const { rules } = parseRobots(TXT, 'other-bot');
  assert.equal(robotsAllows(rules, 'https://a.com/admin/secret'), false);
  assert.equal(robotsAllows(rules, 'https://a.com/admin/public/x'), true);
  assert.equal(robotsAllows(rules, 'https://a.com/anything'), true);
});

test('robotsAllows: empty Disallow allows all, wildcards and $ work', () => {
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:').rules, 'https://a.com/x'), true);
  const wild = parseRobots('User-agent: *\nDisallow: /*.pdf$').rules;
  assert.equal(robotsAllows(wild, 'https://a.com/docs/report.pdf'), false);
  assert.equal(robotsAllows(wild, 'https://a.com/docs/report.pdf?x=1'), true);
});

test('session blobs round-trip and are unreadable without the key', () => {
  const key = randomBytes(32);
  const payload = { cookies: [{ name: 'sid', value: 'secret' }], localStorage: { t: '1' } };
  const blob = seal(payload, key);
  assert.ok(!JSON.stringify(blob).includes('secret'), 'ciphertext must not leak the cookie');
  assert.deepEqual(unseal(blob, key), payload);
  assert.throws(() => unseal(blob, randomBytes(32)));
});

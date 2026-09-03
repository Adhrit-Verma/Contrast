// A public URL-scanner that will fetch anything a visitor pastes is a classic
// SSRF vector — these are the tests that prove it actually refuses the
// addresses that matter, including this deployment's own Tailscale range.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, assertPublicUrl } from '../src/public/ssrf.js';

test('classifyAddress flags every private/reserved IPv4 range', () => {
  assert.equal(classifyAddress('127.0.0.1', 4), 'loopback');
  assert.equal(classifyAddress('10.1.2.3', 4), 'private (RFC1918)');
  assert.equal(classifyAddress('192.168.1.1', 4), 'private (RFC1918)');
  assert.equal(classifyAddress('172.16.0.1', 4), 'private (RFC1918)');
  assert.equal(classifyAddress('172.31.255.255', 4), 'private (RFC1918)');
  assert.equal(classifyAddress('172.32.0.1', 4), null, '172.32 is outside the RFC1918 block');
  assert.equal(classifyAddress('169.254.169.254', 4), 'link-local (cloud metadata lives here)');
  assert.match(classifyAddress('100.90.1.1', 4), /Tailscale/, "this deployment's own tailnet range must be refused");
  assert.equal(classifyAddress('100.63.255.255', 4), null, 'just outside the CGNAT block');
  assert.equal(classifyAddress('8.8.8.8', 4), null, 'a real public address must pass');
});

test('classifyAddress flags loopback and link-local IPv6', () => {
  assert.equal(classifyAddress('::1', 6), 'loopback');
  assert.equal(classifyAddress('fe80::1', 6), 'link-local');
  assert.equal(classifyAddress('fd00::1', 6), 'unique local (private)');
  assert.equal(classifyAddress('2001:4860:4860::8888', 6), null, "Google's public DNS must pass");
});

test('assertPublicUrl refuses non-http(s) schemes and embedded credentials', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /only http\/https/);
  await assert.rejects(assertPublicUrl('not a url'), /not a valid URL/);
  await assert.rejects(assertPublicUrl('http://user:pass@example.com'), /embedded credentials/);
});

test('assertPublicUrl refuses an address that resolves to loopback', async () => {
  await assert.rejects(assertPublicUrl('http://localhost/'), /loopback/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/'), /loopback/);
});

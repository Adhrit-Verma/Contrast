import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPassword, verifyPassword, hasPassword, issueCookie, isAuthed, clearCookie, isHttps } from '../src/auth.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'contrast-auth-'));
const withCookie = (setCookieHeader) => ({ headers: { cookie: setCookieHeader.split(';')[0] } });

test('no password configured means the gate is open — never a lockout', () => {
  const dir = fresh();
  try {
    assert.equal(hasPassword(dir), false);
    assert.equal(isAuthed({ headers: {} }, dir), true, 'an empty install must stay reachable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a set password verifies, a wrong one does not', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    assert.equal(hasPassword(dir), true);
    assert.equal(verifyPassword('correct horse battery', dir), true);
    assert.equal(verifyPassword('correct horse batteryy', dir), false);
    assert.equal(verifyPassword('', dir), false);
    assert.equal(verifyPassword(undefined, dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the password is never stored in readable form', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    const raw = readFileSync(join(dir, '.auth.json'), 'utf8');
    assert.ok(!raw.includes('correct horse battery'), 'plaintext password on disk');
    assert.ok(!raw.includes('scrypt$'), 'the hash itself should be encrypted at rest, not just hashed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('once a password exists, a request with no cookie is refused', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    assert.equal(isAuthed({ headers: {} }, dir), false);
    assert.equal(isAuthed({ headers: { cookie: 'contrast_auth=nonsense' } }, dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cookie this server signed is accepted', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    assert.equal(isAuthed(withCookie(issueCookie({ dir })), dir), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a forged or tampered cookie is refused', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    const real = issueCookie({ dir }).split(';')[0].split('=')[1];
    const [exp, mac] = real.split('.');
    // Same signature, later expiry — the classic "just edit the timestamp" forgery.
    const forged = `${Number(exp) + 86400000}.${mac}`;
    assert.equal(isAuthed({ headers: { cookie: `contrast_auth=${forged}` } }, dir), false);
    // Signature from a different install must not validate here.
    const other = fresh();
    try {
      setPassword('correct horse battery', other);
      const theirs = issueCookie({ dir: other }).split(';')[0].split('=')[1];
      assert.equal(isAuthed({ headers: { cookie: `contrast_auth=${theirs}` } }, dir), false);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired cookie is refused', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    const cookie = issueCookie({ dir });
    // Rewind the clock past the 7-day TTL by forging an already-past expiry:
    // it must fail on the expiry check even before the signature is considered.
    assert.equal(isAuthed({ headers: { cookie: 'contrast_auth=1.deadbeef' } }, dir), false);
    assert.equal(isAuthed(withCookie(cookie), dir), true, 'control: the fresh one still works');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changing the password invalidates every existing session', () => {
  const dir = fresh();
  try {
    setPassword('first password here', dir);
    const before = issueCookie({ dir });
    assert.equal(isAuthed(withCookie(before), dir), true);
    setPassword('second password here', dir);
    assert.equal(isAuthed(withCookie(before), dir), false, 'a password change must log old sessions out');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cookies are HttpOnly and SameSite, and only Secure behind real TLS', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    const plain = issueCookie({ dir, secure: false });
    assert.match(plain, /HttpOnly/);
    assert.match(plain, /SameSite=Strict/);
    assert.ok(!/Secure/.test(plain), 'Secure over plain loopback http would drop the cookie');
    assert.match(issueCookie({ dir, secure: true }), /Secure/);
    assert.match(clearCookie(), /Max-Age=0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isHttps trusts the forwarded header Tailscale Serve sets, nothing else', () => {
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(isHttps({ headers: {} }), false);
  assert.equal(isHttps({ headers: { 'x-forwarded-proto': 'http' } }), false);
});

test('a too-short password is refused outright', () => {
  const dir = fresh();
  try {
    assert.throws(() => setPassword('short', dir), /at least 8/);
    assert.equal(hasPassword(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a non-numeric expiry is refused, not waved through by NaN comparison', () => {
  const dir = fresh();
  try {
    setPassword('correct horse battery', dir);
    assert.equal(isAuthed({ headers: { cookie: 'contrast_auth=abc.deadbeef' } }, dir), false);
    assert.equal(isAuthed({ headers: { cookie: 'contrast_auth=Infinity.deadbeef' } }, dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a damaged auth file opens the gate but says so loudly', () => {
  const dir = fresh();
  const errs = [];
  const real = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    setPassword('correct horse battery', dir);
    writeFileSync(join(dir, '.auth.json'), '{"alg":"aes-256-gcm","iv":"AAAA","tag":"AAAA","data":"AAAA"}');
    assert.equal(hasPassword(dir), false, 'must not fall closed and lock the operator out');
    assert.ok(errs.some((e) => e.includes('password gate is OFF')), 'must not fail open silently');
  } finally {
    console.error = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Session layer. NEVER stores credentials — the auditor logs in by hand in a
// headed browser and we persist only the resulting cookies + web storage,
// encrypted at rest (AES-256-GCM).

import puppeteer from 'puppeteer';
import { createInterface } from 'node:readline/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { attachReadOnlyGuard } from './guard.js';

const sessionPath = (client) => join(client.session.dir, `${client.id}.json`);

/**
 * ponytail: key lives in A11Y_SESSION_KEY (hex/base64, 32 bytes) or, failing
 * that, an auto-generated sessions/.key. That defends against the session file
 * being copied, synced or committed — NOT against an attacker who already has
 * the auditor's disk. Move to OS keychain if that threat model changes.
 */
export function sessionKey(dir) {
  const fromEnv = process.env.A11Y_SESSION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, /^[0-9a-f]{64}$/i.test(fromEnv) ? 'hex' : 'base64');
    if (buf.length !== 32) throw new Error('A11Y_SESSION_KEY must decode to 32 bytes');
    return buf;
  }
  const keyFile = join(dir, '.key');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    console.log(`generated session key → ${keyFile} (set A11Y_SESSION_KEY to manage it yourself)`);
  }
  try { chmodSync(keyFile, 0o600); } catch {}
  return Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
}

export function seal(obj, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unseal(blob, key) {
  if (!blob?.alg) return blob; // legacy plaintext session — read once, re-sealed on next save
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8'));
}

const prompt = async (q) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(q);
  rl.close();
  return answer;
};

// Machine-readable markers on stdout. The dashboard watches for these to mirror
// the browser and to know when the pipeline is blocked on a human.
export const MARK = {
  browser: (ws) => console.log(`[browser-ws] ${ws}`),
  needsLogin: (url, why) => console.log(`[needs-login] ${url} :: ${why}`),
  loggedIn: () => console.log('[login-ok] session captured'),
  blocked: (url, why) => console.log(`[blocked] ${url} :: ${why}`),
};

const CHALLENGE_TEXT =
  /just a moment|attention required|verifying you are human|checking your browser|enable javascript and cookies|access denied|are you a robot/i;

/**
 * Is this a bot-protection wall rather than the client's site? We never try to
 * defeat one — that is off limits — but scanning the block page and reporting
 * its accessibility as the client's would be worse than stopping. So: detect,
 * say so, and let the auditor rerun in a real browser window where they are an
 * ordinary visitor.
 * @returns {Promise<string|null>} why it looks blocked, or null
 */
export async function looksBlocked(page, status) {
  if ([401, 402, 407, 429].includes(status)) return `HTTP ${status}`;
  const title = await page.title().catch(() => '');
  const body = await page
    .evaluate(() => document.body?.innerText?.slice(0, 400) ?? '')
    .catch(() => '');
  if (CHALLENGE_TEXT.test(title) || CHALLENGE_TEXT.test(body)) {
    return `challenge page ("${(title || body).trim().slice(0, 60)}")`;
  }
  // A 403/503 with almost no content is a block; a real page with content is not.
  if ([403, 503].includes(status) && body.replace(/\s+/g, '').length < 600) return `HTTP ${status} with no real content`;
  return null;
}

export async function launch(browserCfg) {
  const browser = await puppeteer.launch({
    headless: browserCfg.headless,
    defaultViewport: browserCfg.viewport,
    args: browserCfg.args ?? [],
  });
  MARK.browser(browser.wsEndpoint());
  return browser;
}

const readStorage = () => ({ localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } });

export async function saveSession(browser, page, client) {
  const origin = new URL(client.seedUrl).origin;
  const storage = await page.evaluate(readStorage).catch(() => ({ localStorage: {}, sessionStorage: {} }));
  mkdirSync(client.session.dir, { recursive: true });
  const payload = { savedAt: new Date().toISOString(), origin, cookies: await browser.cookies(), ...storage };
  writeFileSync(sessionPath(client), JSON.stringify(seal(payload, sessionKey(client.session.dir)), null, 2), { mode: 0o600 });
  console.log(`session saved (encrypted) → ${sessionPath(client)}`);
}

/** @returns {boolean} whether a stored session was applied */
export async function restoreSession(browser, page, client) {
  const path = sessionPath(client);
  if (!existsSync(path)) return false;
  let saved;
  try {
    saved = unseal(JSON.parse(readFileSync(path, 'utf8')), sessionKey(client.session.dir));
  } catch (err) {
    console.log(`could not read ${path} (${err.message}) — treating as no session`);
    return false;
  }

  if (saved.cookies?.length) await browser.setCookie(...saved.cookies);
  // localStorage is origin-scoped: we must be on the origin before writing it.
  await page.goto(saved.origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate((s) => {
    for (const [k, v] of Object.entries(s.localStorage ?? {})) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(s.sessionStorage ?? {})) sessionStorage.setItem(k, v);
  }, saved);
  console.log(`session restored from ${path} (saved ${saved.savedAt})`);
  return true;
}

export function isLoggedOut(page, client) {
  if (!client.loggedOutPattern) return false;
  return new RegExp(client.loggedOutPattern, 'i').test(page.url());
}

/**
 * Does this page look like a sign-in wall? A configured `loggedOutPattern` is
 * authoritative; otherwise we look for a visible password field, which is the
 * one signal that works on a site nobody has configured yet. That is what lets
 * an auditor paste a URL and have the tool work out the rest.
 */
export async function looksSignedOut(page, client) {
  if (client.requiresLogin === false) return false;
  if (isLoggedOut(page, client)) return true;
  if (client.loggedOutPattern) return false; // pattern configured and not matched: trust it
  return page
    .evaluate(() =>
      [...document.querySelectorAll('input[type="password"]')].some((el) => {
        const cs = getComputedStyle(el);
        return el.getClientRects().length && cs.visibility !== 'hidden' && cs.display !== 'none';
      })
    )
    .catch(() => false);
}

/**
 * Headed manual login on an UNGUARDED page — the credential POST must go
 * through. Blocks until a human says they are done, either by pressing Enter in
 * the CLI or by clicking Continue in the dashboard (which writes to our stdin).
 */
export async function interactiveLogin(browser, client, { url = client.seedUrl, why = 'this site requires a login' } = {}) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: client.browser.navTimeoutMs }).catch(() => {});
  MARK.needsLogin(page.url(), why);
  await prompt(`\n  Sign in to ${client.id} in the browser, land on a signed-in page,\n  then press Enter here (or Continue in the dashboard). > `);
  await saveSession(browser, page, client);
  MARK.loggedIn();
  await page.close();
}

/**
 * Returns a guarded, logged-in context ready to scan. Handles cold start and expiry.
 * `newPage()` mints additional guarded pages (crawl concurrency, fix verification).
 * Caller closes the browser.
 */
export async function openSession(client, { onBlocked, autoLogin = true } = {}) {
  const browser = await launch(client.browser);
  const blocked = onBlocked ?? (() => {});
  const newPage = async () => {
    const p = await browser.newPage();
    p.setDefaultNavigationTimeout(client.browser.navTimeoutMs);
    if (client.crawl.userAgent) await p.setUserAgent(await browser.userAgent() + ` ${client.crawl.userAgent}`);
    await attachReadOnlyGuard(p, client.crawl, blocked);
    return p;
  };
  const page = await newPage();

  const restored = await restoreSession(browser, page, client);
  if (restored) {
    await page.goto(client.seedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  const session = { browser, page, newPage, loggedIn: true };
  // `true` = always sign in first. `false` = never. Anything else (the default
  // for a site added by pasting a URL) = don't ask up front; detect it if and
  // when we actually hit a wall.
  const upFront = client.requiresLogin === true;
  if (upFront && (!restored || isLoggedOut(page, client))) {
    console.log(restored ? 'session expired — re-login needed' : 'no stored session');
    session.loggedIn = false;
    // The graph's login node owns the prompt when autoLogin is off, so the
    // auditor becomes a node instead of a side channel.
    if (autoLogin) {
      await interactiveLogin(browser, client);
      await page.goto(client.seedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      session.loggedIn = true;
    }
  }
  return session;
}

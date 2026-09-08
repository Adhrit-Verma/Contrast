// Password login for the two PRIVATE surfaces (the dashboard and the funnel
// panel). This is a second layer, not a replacement: both servers still bind
// 127.0.0.1 and are reached over Tailscale. The password is what stops a
// device that is already on the tailnet — a phone, a shared laptop, a machine
// someone else borrowed — from being the same thing as an authenticated
// operator.
//
// Deliberately not enforced until a password exists. Gating an empty install
// would lock the operator out of the only UI that could let them in; until
// `node src/cli.js set-password` is run, access control is exactly what it was
// before (tailnet membership) and the dashboard says so in a banner.
//
// Storage is its own directory, NOT sessions/. sessions/ holds the Gemini key
// and real browser cookies, and the funnel panel has no business mounting it.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seal, unseal, sessionKey } from './browser/session.js';

const COOKIE = 'contrast_auth';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// scrypt cost. N=16384 keeps a single verification near ~50ms on a small VPS —
// slow enough to make offline guessing expensive, fast enough for a login.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

export const authDir = () => process.env.AUTH_DIR ?? 'auth';

const file = (dir) => join(dir, '.auth.json');

function read(dir) {
  const path = file(dir);
  if (!existsSync(path)) return {};
  try {
    return unseal(JSON.parse(readFileSync(path, 'utf8')), sessionKey(dir));
  } catch {
    // A file that exists but will not decrypt means the key was lost or the
    // file was damaged — and because "no password" means "no gate", that
    // silently reopens the panel. Falling closed instead would lock the
    // operator out with no way back in, so this stays open but refuses to be
    // quiet about it.
    console.error(`[auth] ${path} exists but could not be decrypted — the password gate is OFF. ` +
      'Re-run `node src/cli.js set-password` to restore it.');
    return {};
  }
}

function write(obj, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(seal(obj, sessionKey(dir)), null, 2), { mode: 0o600 });
}

export const hasPassword = (dir = authDir()) => !!read(dir).passwordHash;

/**
 * Set (or change) the password. Changing it rotates the signing secret too, so
 * every existing session dies — which is the behaviour you want from a
 * password change, and the only revocation mechanism a single-user tool needs.
 */
export function setPassword(password, dir = authDir()) {
  if (!password || password.length < 8) throw new Error('password must be at least 8 characters');
  const salt = randomBytes(16);
  write({
    passwordHash: `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, KEYLEN, SCRYPT).toString('hex')}`,
    signingSecret: randomBytes(32).toString('hex'),
  }, dir);
}

export function verifyPassword(password, dir = authDir()) {
  const stored = read(dir).passwordHash;
  if (!stored?.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password ?? ''), Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

const sign = (value, secret) => createHmac('sha256', secret).update(String(value)).digest('hex');

/** A session token is just an expiry the server signed. Nothing else is in it,
 *  because there is nothing else: one operator, one password. */
export function issueCookie({ dir = authDir(), secure = false } = {}) {
  const { signingSecret } = read(dir);
  const expires = Date.now() + TTL_MS;
  const token = `${expires}.${sign(expires, signingSecret)}`;
  return [
    `${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`, secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

const cookies = (header) =>
  Object.fromEntries(String(header ?? '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));

/** True when this request may proceed — either no password is configured yet,
 *  or it carries a signed, unexpired cookie. */
export function isAuthed(req, dir = authDir()) {
  const { passwordHash, signingSecret } = read(dir);
  if (!passwordHash) return true; // not configured: tailnet membership is the gate, as before
  const token = cookies(req.headers?.cookie)[COOKIE];
  if (!token) return false;
  const [expires, mac] = token.split('.');
  // Number('abc') is NaN and every NaN comparison is false, so checking only
  // `< Date.now()` would wave a non-numeric expiry straight past the deadline.
  // It could still never forge the signature below, but the check should mean
  // what it says.
  if (!expires || !mac || !Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return false;
  const want = Buffer.from(sign(expires, signingSecret), 'hex');
  const got = Buffer.from(mac, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Tailscale Serve terminates TLS and forwards plain http to loopback, so the
 *  socket is never encrypted here — the forwarded header is the only honest
 *  signal, and marking the cookie Secure over plain local http would make it
 *  vanish during development. */
export const isHttps = (req) => String(req.headers['x-forwarded-proto'] ?? '').includes('https');

export const loginPage = ({ error = null, title = 'Contrast' } = {}) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — ${title}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='%23cc785c'/><path d='M8 3a5 5 0 000 10z' fill='%23141413'/></svg>">
<link rel="stylesheet" href="/app.css">
</head><body>
<main class="content" style="max-width:380px;margin:12vh auto" role="main">
  <div style="display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-5)">
    <span style="width:32px;height:32px;border-radius:var(--r-2);background:var(--accent);display:grid;place-items:center;flex:none">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4a8 8 0 000 16z" fill="#141413"/></svg>
    </span>
    <b style="font-family:var(--font-display);font-size:var(--fs-title)">${title}</b>
  </div>
  <h1 style="margin-bottom:var(--s-2)">Sign in</h1>
  <p class="dim" style="margin:0 0 var(--s-4);font-size:var(--fs-sm)">
    This machine is already on your private network — the password is the second lock.</p>
  <form method="POST" action="/login" class="card">
    ${error ? `<p class="notice" role="alert" style="margin-bottom:var(--s-3)">${error}</p>` : ''}
    <label class="field" style="margin-bottom:var(--s-4)"><span>Password</span>
      <input type="password" name="password" autocomplete="current-password" autofocus required></label>
    <button class="btn primary" type="submit" style="width:100%">Sign in</button>
  </form>
</main>
</body></html>`;

/** The login form is a plain HTML form on purpose — it works with no
 *  JavaScript, and browsers offer to save the password. So the body arrives
 *  urlencoded, not as JSON like every other POST in this codebase. */
function readForm(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', reject);
  });
}

/**
 * The whole gate, so both servers apply identical rules rather than each
 * growing its own near-miss version. Returns true when it has fully handled
 * the request (and the caller must stop), false when the request may proceed.
 *
 * `limiter` is an ipLimiter. Every attempt costs quota, successes included —
 * the budget is set high enough that a human never notices and a guessing loop
 * always does.
 */
export async function handleAuth(req, res, { url, ip, dir = authDir(), limiter, title }) {
  const send = (code, body, type = 'text/html; charset=utf-8', headers = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const redirect = (to, headers = {}) => {
    res.writeHead(302, { location: to, 'cache-control': 'no-store', ...headers });
    res.end();
  };

  if (url.pathname === '/logout') {
    redirect('/login', { 'set-cookie': clearCookie() });
    return true;
  }

  if (url.pathname === '/login') {
    // Nothing to sign in to yet — don't show a form no password can satisfy.
    if (!hasPassword(dir)) {
      redirect('/');
      return true;
    }
    if (req.method === 'GET') {
      send(200, loginPage({ title }));
      return true;
    }
    if (req.method === 'POST') {
      // Spend quota BEFORE checking the password, or the limit is decorative:
      // a limiter consulted only after a wrong guess never refuses the next one.
      const gate = limiter?.check(ip);
      if (gate && !gate.allowed) {
        send(429, loginPage({ title, error: 'Too many attempts. Try again later.' }));
        return true;
      }
      const form = await readForm(req);
      if (verifyPassword(form.password, dir)) {
        redirect('/', { 'set-cookie': issueCookie({ dir, secure: isHttps(req) }) });
        return true;
      }
      send(401, loginPage({ title, error: 'That password is not right.' }));
      return true;
    }
  }

  if (isAuthed(req, dir)) return false;

  // Unauthenticated from here down. The login page still needs its stylesheet.
  if (url.pathname === '/app.css' || url.pathname === '/tokens.css') return false;
  if (url.pathname.startsWith('/api/')) {
    send(401, JSON.stringify({ error: 'sign in required' }), 'application/json');
    return true;
  }
  redirect('/login');
  return true;
}

// The Step 6 public funnel: paste a URL, get a deterministic scan, get a
// shareable report link. Deliberately a SEPARATE small server, not new routes
// on the admin dashboard (src/ui/server.js) — it never reads config.json,
// never mounts sessions/ (where the Gemini key lives encrypted), and never
// calls Gemini at all. The blast radius of "anyone on the internet can make
// this process fetch a URL and run a real headless browser" needs to stay as
// small as the codebase can make it.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from '../browser/session.js';
import { crawl } from '../browser/crawl.js';
import { scanPage, startRun, finishRun, runDir } from '../scan/index.js';
import { openDb, getRun, setRunNotes } from '../db.js';
import { writeHtml, writeJson } from '../report/index.js';
import { loadKnowledge, criteriaCatalogue } from '../ai/knowledge.js';
import { assertPublicUrl } from './ssrf.js';
import { createIpLimiter, createConcurrencyGate } from './ipLimiter.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const VALID_ID = /^[\w:.-]+$/; // blocks `/`, `..`, null bytes — anything path-traversal-shaped

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

// Caps chosen to bound one anonymous visitor's worst case: a handful of pages,
// one real browser at a time per scan, a small number of scans per IP per
// hour, and never more than a couple of scans running on the box at once.
const MAX_PAGES = Number(process.env.PUBLIC_MAX_PAGES ?? 5);
const SCANS_PER_IP_PER_HOUR = Number(process.env.PUBLIC_RATE_LIMIT ?? 3);
const MAX_CONCURRENT_SCANS = Number(process.env.PUBLIC_MAX_CONCURRENT ?? 2);

/** Everything crawl()/scanPage() need, built fresh per request — never
 *  persisted to config.json, never shared between visitors. */
function ephemeralClient(seedUrl, runId) {
  return {
    id: `pub-${runId}`,
    seedUrl,
    requiresLogin: false, // the public funnel never signs in anywhere
    browser: { headless: true, viewport: { width: 1440, height: 900 }, navTimeoutMs: 20000, args: [] },
    session: { dir: 'runs/public-sessions' }, // never actually written to — see below
    crawl: {
      maxDepth: 1, maxPages: MAX_PAGES, settleMs: 400, concurrency: 1,
      respectRobots: true, seedFromSitemap: false, userAgent: 'contrast-public-scanner',
      allowlist: [], denylist: ['/logout', '/signout', '/delete', '/unsubscribe'],
      skipExtensions: ['.pdf', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.mp3', '.css', '.js', '.ico', '.woff', '.woff2', '.ttf'],
      pageTimeoutMs: 45000,
    },
    scan: {
      lighthouse: false, a11yTree: true, a11yTreeInterestingOnly: true, keyboard: true,
      maxTabs: 30, screenshots: true, maxElementShots: 20, maxImageShots: 6,
      axeTimeoutMs: 30000, inventory: false, // no AI step, so no need to collect AI candidates
      enrichBudgetMs: 20000,
    },
  };
}

function normaliseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

export function startPublicUi({ port = 8080, dbPath = 'runs/public.sqlite', knowledgeDir = 'knowledge' } = {}) {
  mkdirSync('runs', { recursive: true });
  const db = openDb(dbPath);
  const ipLimiter = createIpLimiter({ max: SCANS_PER_IP_PER_HOUR });
  const gate = createConcurrencyGate(MAX_CONCURRENT_SCANS);
  const jobs = new Map(); // runId -> { status: 'running'|'done'|'error', error? }
  let kb = null;
  loadKnowledge({ dir: knowledgeDir }).then((k) => (kb = k));
  setInterval(() => ipLimiter.sweep(), 10 * 60 * 1000).unref();

  const rootAbs = resolve('runs');

  async function runScan(runId, seedUrl) {
    jobs.set(runId, { status: 'running' });
    const client = ephemeralClient(seedUrl, runId);
    let session;
    try {
      session = await openSession(client);
      let total = 0;
      await crawl(session, client, async (page, info) => {
        const { findings } = await scanPage(page, info, { runId, client, db, persist: true });
        total += findings.length;
      }, {
        onAbandoned: (reason) => setRunNotes(db, runId, reason),
      });
      finishRun(db, runId);
      const catalogue = criteriaCatalogue(kb ?? { chunks: [] });
      writeJson(db, runId, join(runDir(runId), 'report.json'), catalogue);
      writeHtml(db, runId, join(runDir(runId), 'report.html'), catalogue);
      jobs.set(runId, { status: 'done' });
    } catch (err) {
      setRunNotes(db, runId, `scan failed: ${err.message}`);
      finishRun(db, runId);
      jobs.set(runId, { status: 'error', error: err.message });
    } finally {
      await session?.browser?.close().catch(() => {});
      gate.release();
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj, extraHeaders = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders });
      res.end(JSON.stringify(obj));
    };
    // req.socket.remoteAddress is authoritative here: this process is reached
    // directly (bare IP:port), with no reverse proxy in front to spoof via
    // X-Forwarded-For. If a proxy is added later (a domain, step 7), this is
    // the one line that needs to change — trusting that header blindly today,
    // with nothing in front to set it honestly, would make the rate limit a
    // no-op for anyone who sends their own.
    const ip = req.socket.remoteAddress ?? 'unknown';

    try {
      if (url.pathname === '/' && req.method === 'GET') {
        return send(200, readFileSync(join(PUBLIC_DIR, 'index.html'))); // the landing page
      }
      if (url.pathname === '/scan' && req.method === 'GET') {
        return send(200, readFileSync(join(PUBLIC_DIR, 'scan.html'))); // the paste-a-URL tool
      }

      if (url.pathname === '/scan' && req.method === 'POST') {
        // Validate BEFORE spending the visitor's quota: a typo'd URL or a
        // blocked SSRF attempt is cheap and must stay free, or two mistakes
        // would burn a legitimate visitor's whole hourly allowance on nothing.
        let body = '';
        for await (const chunk of req) body += chunk;
        let seedUrl;
        try {
          const parsed = JSON.parse(body || '{}');
          const normalised = normaliseUrl(parsed.url);
          if (!normalised) throw new Error('that is not a http(s) address');
          seedUrl = await assertPublicUrl(normalised);
        } catch (err) {
          return json(400, { error: err.message });
        }

        const limit = ipLimiter.check(ip);
        if (!limit.allowed) {
          return json(429, { error: `Too many scans from this address — try again in ${Math.ceil(limit.retryAfterMs / 60000)} min.` }, { 'retry-after': String(Math.ceil(limit.retryAfterMs / 1000)) });
        }
        if (!gate.tryAcquire()) {
          return json(503, { error: 'The scanner is busy right now — please try again in a minute.' });
        }

        // startRun() generates its own runId internally and that return value
        // is the only copy that actually lands in the `runs` table — capture
        // it here rather than minting a second, never-inserted id.
        const runId = startRun(db, { id: 'contrast-public', seedUrl });
        // Respond immediately; the scan itself runs in the background and the
        // page polls /status. A visitor's browser should not have to hold a
        // connection open for the ~30-60s a real crawl can take.
        runScan(runId, seedUrl);
        return json(202, { runId, statusUrl: `/status/${runId}`, reportUrl: `/r/${runId}` });
      }

      const status = /^\/status\/([\w:.-]+)$/.exec(url.pathname);
      if (status && req.method === 'GET') {
        const runId = status[1];
        const run = getRun(db, runId);
        if (!run) return json(404, { error: 'no such scan' });
        const job = jobs.get(runId);
        return json(200, {
          status: job?.status ?? (run.finishedAt ? 'done' : 'running'),
          error: job?.error ?? null,
          notes: run.notes ?? null,
        });
      }

      const report = /^\/r\/([\w:.-]+)$/.exec(url.pathname);
      if (report && req.method === 'GET') {
        const runId = report[1];
        if (!getRun(db, runId)) return send(404, 'no such scan');
        const catalogue = criteriaCatalogue(kb ?? { chunks: [] });
        writeHtml(db, runId, join(runDir(runId), 'report.html'), catalogue);
        res.writeHead(302, { location: `/runs/${encodeURIComponent(runId)}/report.html` });
        return res.end();
      }

      // Static assets for a run's report — screenshots, the generated HTML.
      // The directory is physically shared with nothing else this process
      // owns, but the authorisation boundary is the check below, not the
      // filesystem: a runId that isn't in OUR OWN public.sqlite 404s here
      // even if a file happens to exist on disk at that path.
      if (url.pathname.startsWith('/runs/')) {
        const rel = decodeURIComponent(url.pathname.slice('/runs/'.length));
        const runId = rel.split('/')[0];
        if (!VALID_ID.test(runId) || !getRun(db, runId)) return send(404, 'not found');
        const path = resolve(rootAbs, rel);
        if (!(path === rootAbs || path.startsWith(rootAbs + sep))) return send(403, 'forbidden');
        if (!existsSync(path) || statSync(path).isDirectory()) return send(404, 'not found');
        return send(200, readFileSync(path), MIME[extname(path)] ?? 'application/octet-stream');
      }

      const asset = url.pathname.slice(1);
      const assetPath = resolve(PUBLIC_DIR, asset);
      if ((assetPath === PUBLIC_DIR || assetPath.startsWith(PUBLIC_DIR + sep)) && existsSync(assetPath) && statSync(assetPath).isFile()) {
        return send(200, readFileSync(assetPath), MIME[extname(assetPath)] ?? 'application/octet-stream');
      }

      send(404, 'not found');
    } catch (err) {
      json(500, { error: err.message });
    }
  });

  // 0.0.0.0 deliberately — this one IS meant to be public, unlike the admin
  // dashboard's 127.0.0.1-only bind in src/ui/server.js.
  server.listen(port, '0.0.0.0', () => {
    console.log(`public scanner → http://0.0.0.0:${port} (max ${MAX_PAGES} pages/scan, ${SCANS_PER_IP_PER_HOUR}/hr/IP, ${MAX_CONCURRENT_SCANS} concurrent)`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startPublicUi({ port: Number(process.env.PUBLIC_PORT) || 8080 });
}

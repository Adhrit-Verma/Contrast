// A third, standalone service: monitoring/analytics/DBMS for the public
// scanner's own data (runs/public.sqlite). Deliberately separate from both
// the admin dashboard (src/ui/server.js) and the public scanner itself
// (src/public/server.js) — not a tab bolted onto either. 127.0.0.1 only, same
// access model as the admin dashboard (Tailscale reaches it, the open
// internet does not) — this is a private tool, not a second public surface.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, deleteRun, insertIncident, listIncidents, markIncidentReviewed, insertRule, listRules } from '../db.js';
import { runDir } from '../scan/index.js';
import { fundingState, currentRaised } from '../public/funding.js';
import { cleanupOldRuns } from '../public/cleanup.js';
import { handleAuth, hasPassword } from '../auth.js';
import { createIpLimiter } from '../public/ipLimiter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
// Design tokens/components are read straight from the dashboard's own files
// rather than copy-pasted — one source of truth for "same design system",
// with no import-time coupling to ui/server.js itself.
const UI_PUBLIC = join(HERE, '..', 'ui', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
};

// The only tables the browser may name. A request can never supply a table
// name that reaches SQL — it can only pick one of these.
const TABLES = ['runs', 'pages', 'findings', 'scan_meta', 'scan_incidents', 'crawl_rules', 'click_events', 'visits'];

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

/** How much disk the public scanner's artifacts are actually using — the
 *  number that makes the 15-day retention policy feel real. */
function storageBytes(root = 'runs') {
  let total = 0;
  try {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try { total += statSync(join(entry.parentPath ?? entry.path ?? root, entry.name)).size; } catch {}
    }
  } catch {}
  return total;
}

/** Long blobs (htmlSnippet, a11yTree, raw JSON) make a table view unreadable
 *  and the response enormous — the browser shows a preview, not the payload. */
const clip = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  const s = v == null ? null : String(v);
  return [k, s && s.length > 160 ? `${s.slice(0, 160)}…` : s];
}));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula;
  // prefixing an apostrophe is the standard defusing for exported data.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
}

/** @returns {string|null} why the request was refused, or null if it is fine.
 *  Duplicated (not imported) from ui/server.js on purpose — this service
 *  stays standalone rather than depending on the admin dashboard's module. */
function csrfProblem(req, port) {
  if (req.headers['x-a11y-ui'] !== '1') return 'missing x-a11y-ui header';
  const origin = req.headers.origin;
  if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) {
    return `origin ${origin} not allowed`;
  }
  return null;
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); }
    });
  });
}

export function startFunnelUi({ port = 4322, dbPath = 'runs/public.sqlite' } = {}) {
  const loginLimiter = createIpLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
  setInterval(() => loginLimiter.sweep(), 15 * 60 * 1000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj), 'application/json');
    const safe = (base, rel) => {
      const path = resolve(base, rel);
      return path === base || path.startsWith(base + sep) ? path : null;
    };

    try {
      // Same password as the dashboard — one operator, one credential, shared
      // via the auth/ directory both private services mount (never the public
      // scanner). A no-op until a password has been set.
      if (await handleAuth(req, res, {
        url, ip: req.socket.remoteAddress ?? 'unknown',
        limiter: loginLimiter, title: 'Contrast funnel',
      })) return;

      const db = openDb(dbPath);

      if (url.pathname === '/api/auth' && req.method === 'GET') {
        return json(200, { passwordSet: hasPassword() });
      }

      // ------------------------------------------------------- DBMS tools
      // Table names can never come from the caller — every query below picks
      // from this list, so there is no string a request could supply that
      // reaches SQL.
      if (url.pathname === '/api/tables' && req.method === 'GET') {
        const tables = TABLES.map((name) => ({
          name, rows: db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n,
        }));
        return json(200, { tables, storage: storageBytes() });
      }

      const table = /^\/api\/table\/(\w+)$/.exec(url.pathname);
      if (table && req.method === 'GET') {
        const name = table[1];
        if (!TABLES.includes(name)) return json(400, { error: 'unknown table' });
        const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 500);
        const offset = Number(url.searchParams.get('offset')) || 0;
        const total = db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
        const rows = db.prepare(`SELECT * FROM ${name} LIMIT ? OFFSET ?`).all(limit, offset);
        if (url.searchParams.get('format') === 'csv') {
          const all = db.prepare(`SELECT * FROM ${name}`).all();
          return send(200, toCsv(all), 'text/csv; charset=utf-8');
        }
        return json(200, { name, total, limit, offset, rows: rows.map(clip) });
      }

      const ruleDelete = /^\/api\/rules\/([\w-]+)\/delete$/.exec(url.pathname);
      if (ruleDelete && req.method === 'POST') {
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        db.prepare('DELETE FROM crawl_rules WHERE id = ?').run(ruleDelete[1]);
        return json(200, { ok: true });
      }

      // One run in full — the drill-down behind a row in the scans table.
      const runDetail = /^\/api\/runs\/([\w:.-]+)$/.exec(url.pathname);
      if (runDetail && req.method === 'GET') {
        const runId = runDetail[1];
        const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!run) return json(404, { error: 'no such run' });
        return json(200, {
          run,
          meta: db.prepare('SELECT * FROM scan_meta WHERE runId = ?').get(runId) ?? null,
          pages: db.prepare('SELECT url, finalUrl, title, status, error FROM pages WHERE runId = ?').all(runId),
          bySeverity: db.prepare('SELECT severity, COUNT(*) n FROM findings WHERE runId = ? GROUP BY severity').all(runId),
          topRules: db.prepare(`
            SELECT ruleId, COUNT(*) n FROM findings WHERE runId = ?
            GROUP BY ruleId ORDER BY n DESC LIMIT 10
          `).all(runId),
          incidents: db.prepare('SELECT * FROM scan_incidents WHERE runId = ?').all(runId),
        });
      }

      if (url.pathname === '/api/summary' && req.method === 'GET') {
        const totals = db.prepare('SELECT COUNT(*) n, SUM(finishedAt IS NOT NULL) done FROM runs').get();
        const byDay = db.prepare(`
          SELECT substr(startedAt, 1, 10) day, COUNT(*) n FROM runs
          WHERE startedAt >= datetime('now', '-30 days') GROUP BY day ORDER BY day
        `).all();
        const devices = db.prepare('SELECT device, COUNT(*) n FROM scan_meta GROUP BY device ORDER BY n DESC').all();
        const regions = db.prepare(`
          SELECT COALESCE(NULLIF(country, ''), 'unknown') country, COUNT(*) n
          FROM scan_meta GROUP BY country ORDER BY n DESC
        `).all();
        const clicks = db.prepare('SELECT button, COUNT(*) n FROM click_events GROUP BY button').all();
        const visits = db.prepare('SELECT COUNT(*) n, SUM(lastSeen != firstSeen) returned FROM visits').get();
        const scanners = db.prepare('SELECT COUNT(DISTINCT ipHash) n FROM scan_meta WHERE ipHash IS NOT NULL').get();
        const scans = db.prepare('SELECT COUNT(*) n FROM scan_meta').get();
        const bySeverity = db.prepare('SELECT severity, COUNT(*) n FROM findings GROUP BY severity').all();
        const byHour = db.prepare(`
          SELECT CAST(substr(startedAt, 12, 2) AS INTEGER) hour, COUNT(*) n
          FROM runs WHERE startedAt IS NOT NULL GROUP BY hour
        `).all();
        // Outcome is derived, not stored: a run that finished with no note is
        // a clean pass, a note beginning "scan failed" is an error, and any
        // other note is the crawl stopping itself (bot-blocked, robots, etc).
        const outcomes = db.prepare(`
          SELECT CASE
            WHEN notes LIKE 'scan failed%' THEN 'errored'
            WHEN notes IS NOT NULL THEN 'blocked'
            WHEN finishedAt IS NOT NULL THEN 'completed'
            ELSE 'running' END outcome,
          COUNT(*) n FROM runs GROUP BY outcome
        `).all();
        // Hostnames need real URL parsing, which SQLite has none of — and the
        // row count here is small enough that doing it in JS costs nothing.
        const domains = new Map();
        for (const { seedUrl } of db.prepare('SELECT seedUrl FROM runs WHERE seedUrl IS NOT NULL').all()) {
          let host;
          try { host = new URL(seedUrl).hostname; } catch { host = seedUrl; }
          domains.set(host, (domains.get(host) ?? 0) + 1);
        }
        const topDomains = [...domains.entries()]
          .map(([host, n]) => ({ host, n })).sort((a, b) => b.n - a.n).slice(0, 8);

        const durations = db.prepare('SELECT startedAt, finishedAt FROM runs WHERE finishedAt IS NOT NULL').all()
          .map((r) => (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)
          .filter((s) => Number.isFinite(s) && s >= 0)
          .sort((a, b) => a - b);

        // A funnel is only honest if every stage counts the SAME population
        // getting smaller. Counting visitors then total scans produces stages
        // that grow — "490% continued" — because one person can scan five
        // times. So every stage here is distinct people.
        const journey = {
          visitors: visits.n ?? 0,
          scanned: scanners.n ?? 0,
          completed: db.prepare(`
            SELECT COUNT(DISTINCT m.ipHash) n FROM scan_meta m
            JOIN runs r ON r.id = m.runId
            WHERE r.finishedAt IS NOT NULL AND r.notes IS NULL AND m.ipHash IS NOT NULL
          `).get().n,
          clicked: db.prepare('SELECT COUNT(DISTINCT ipHash) n FROM click_events WHERE ipHash IS NOT NULL').get().n,
        };

        return json(200, {
          totalScans: totals.n ?? 0,
          completionRate: totals.n ? (totals.done ?? 0) / totals.n : 0,
          scansByDay: byDay,
          journey,
          devices, regions, clicks, bySeverity, byHour, outcomes, topDomains,
          duration: {
            n: durations.length,
            p50: percentile(durations, 0.5),
            p95: percentile(durations, 0.95),
          },
          retention: {
            visitors: visits.n ?? 0,
            returning: visits.returned ?? 0,
            rate: visits.n ? (visits.returned ?? 0) / visits.n : 0,
            avgScansPerVisitor: scanners.n ? (scans.n ?? 0) / scanners.n : 0,
          },
          totalFindings: db.prepare('SELECT COUNT(*) n FROM findings').get().n,
          rules: listRules(db).length,
          openIncidents: listIncidents(db).length,
          funding: fundingState(currentRaised()),
        });
      }

      if (url.pathname === '/api/runs' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const offset = Number(url.searchParams.get('offset')) || 0;
        const rows = db.prepare(`
          SELECT r.id, r.seedUrl, r.startedAt, r.finishedAt, r.notes,
                 (SELECT COUNT(*) FROM findings f WHERE f.runId = r.id) findingCount,
                 m.device, m.country
          FROM runs r LEFT JOIN scan_meta m ON m.runId = r.id
          ORDER BY r.startedAt DESC LIMIT ? OFFSET ?
        `).all(limit, offset);
        return json(200, { runs: rows });
      }

      const runAction = /^\/api\/runs\/([\w:.-]+)\/(delete|flag)$/.exec(url.pathname);
      if (runAction && req.method === 'POST') {
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const [, runId, action] = runAction;
        if (action === 'delete') {
          deleteRun(db, runId);
          rmSync(runDir(runId), { recursive: true, force: true });
        } else {
          const body = await readJson(req);
          insertIncident(db, { runId, kind: 'manual', detail: body.note || 'flagged from the funnel panel' });
        }
        return json(200, { ok: true });
      }

      if (url.pathname === '/api/incidents' && req.method === 'GET') {
        return json(200, { incidents: listIncidents(db) });
      }

      const incidentAction = /^\/api\/incidents\/([\w-]+)\/(rule|dismiss)$/.exec(url.pathname);
      if (incidentAction && req.method === 'POST') {
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const [, incidentId, action] = incidentAction;
        if (action === 'rule') {
          const body = await readJson(req);
          if (!body.patternType || !body.pattern) return json(400, { error: 'patternType and pattern are required' });
          insertRule(db, {
            patternType: body.patternType, pattern: body.pattern,
            action: body.action || 'treat_as_blocked', note: body.note ?? null, sourceIncidentId: incidentId,
          });
        }
        markIncidentReviewed(db, incidentId);
        return json(200, { ok: true });
      }

      if (url.pathname === '/api/rules' && req.method === 'GET') {
        return json(200, { rules: listRules(db) });
      }

      if (url.pathname === '/api/cleanup' && req.method === 'POST') {
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        return json(200, { deleted: cleanupOldRuns(db, Number(process.env.PUBLIC_RUN_RETENTION_DAYS) || 15) });
      }

      // Design tokens/components straight from the dashboard's own files.
      if (url.pathname === '/tokens.css' || url.pathname === '/app.css') {
        const path = join(UI_PUBLIC, url.pathname.slice(1));
        if (existsSync(path)) return send(200, readFileSync(path), MIME['.css']);
      }

      const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = safe(PUBLIC, asset);
      if (path && existsSync(path) && statSync(path).isFile()) {
        return send(200, readFileSync(path), MIME[extname(path)] ?? 'application/octet-stream');
      }

      send(404, 'not found');
    } catch (err) {
      if (url.pathname.startsWith('/api/')) return json(500, { error: err.message });
      send(500, `<pre>${err.stack}</pre>`);
    }
  });

  // 127.0.0.1, not 0.0.0.0 — a private monitoring tool, same access model as
  // the admin dashboard (reached over Tailscale, never the open internet).
  server.listen(port, '127.0.0.1', () => {
    console.log(`funnel monitoring → http://localhost:${port}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startFunnelUi({ port: Number(process.env.FUNNEL_PORT) || 4322 });
}

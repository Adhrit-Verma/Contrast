// A third, standalone service: monitoring/analytics/DBMS for the public
// scanner's own data (runs/public.sqlite). Deliberately separate from both
// the admin dashboard (src/ui/server.js) and the public scanner itself
// (src/public/server.js) — not a tab bolted onto either. 127.0.0.1 only, same
// access model as the admin dashboard (Tailscale reaches it, the open
// internet does not) — this is a private tool, not a second public surface.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, deleteRun, insertIncident, listIncidents, markIncidentReviewed, insertRule, listRules } from '../db.js';
import { runDir } from '../scan/index.js';
import { fundingState, currentRaised } from '../public/funding.js';
import { cleanupOldRuns } from '../public/cleanup.js';

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
      const db = openDb(dbPath);

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
        return json(200, {
          totalScans: totals.n ?? 0,
          completionRate: totals.n ? (totals.done ?? 0) / totals.n : 0,
          scansByDay: byDay,
          devices, regions, clicks,
          retention: {
            visitors: visits.n ?? 0,
            returning: visits.returned ?? 0,
            rate: visits.n ? (visits.returned ?? 0) / visits.n : 0,
            avgScansPerVisitor: scanners.n ? (scans.n ?? 0) / scanners.n : 0,
          },
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

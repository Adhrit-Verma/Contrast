// The "frontend": run browser + run launcher. node:http + static files + a
// small JSON API. No framework, no build step.
//
// Mutating routes can start a real scan against a client site, so they are
// fenced: bound to 127.0.0.1, POST only, a custom header no cross-origin form
// can forge, an Origin check, and a fixed command allowlist (see jobs.js).
// Without those, any page the auditor happened to visit could drive this.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, listRuns, getFindings, getFixes, getReviewQueue, pinRun, deleteRun, runIdsForClient } from '../db.js';
import { writeHtml, writeJson, writeDiffHtml, writeVpat, buildReport, diffRuns } from '../report/index.js';
import { runDir } from '../scan/index.js';
import { loadKnowledge, criteriaCatalogue } from '../ai/knowledge.js';
import {
  groupTree, resolveTarget,
  renameClient, moveClient, pinClient, deleteClient, renameGroup, pinGroup, deleteGroup,
} from '../config.js';
import { startJob, listJobs, getJob, sendStdin, stopJob, subscribe, killAll, COMMANDS } from './jobs.js';
import { streamBrowser, forwardInput, detachBrowser } from './browser-bridge.js';
import { loadSecrets, setSecret, preview, applySecrets } from '../secrets.js';
import { detectSetup } from '../ai/probe.js';
import { writeFileSync, readFileSync as readCfg, rmSync, renameSync } from 'node:fs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** DB paths are OS-native; the browser needs a URL under /runs/. */
const shotUrl = (p) => (p ? '/' + String(p).replace(/\\/g, '/').replace(/^\/+/, '') : null);

export function startUi({ cfg, port = 4321, root = 'runs' } = {}) {
  const dbPath = cfg.db?.path ?? 'runs/audit.sqlite';
  const rootAbs = resolve(root);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const send = (code, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj), 'application/json');
    const redirect = (to) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    /** Resolve inside a root or refuse — one line, worth it even on localhost. */
    const safe = (base, rel) => {
      const path = resolve(base, rel);
      return path === base || path.startsWith(base + sep) ? path : null;
    };

    try {
      // ------------------------------------------------------- job control
      if (url.pathname.startsWith('/api/jobs')) {
        // SSE stream is a GET; everything else that touches a job is a POST
        // behind the CSRF fence.
        const stream = /^\/api\/jobs\/([\w-]+)\/stream$/.exec(url.pathname);
        if (stream && req.method === 'GET') {
          return subscribe(stream[1], res) || json(404, { error: 'no such job' });
        }
        if (url.pathname === '/api/jobs' && req.method === 'GET') return json(200, listJobs());

        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const bad = csrfProblem(req, port);
        if (bad) return json(403, { error: bad });

        const body = await readJson(req);
        if (url.pathname === '/api/jobs') {
          if (!COMMANDS[body.command]) return json(400, { error: 'unknown command' });
          // Only clients/groups that exist in config.json — never a caller-supplied target.
          if (body.clientId && !cfg.clients?.[body.clientId]) return json(400, { error: 'unknown client' });
          if (body.target) {
            try { resolveTarget(cfg, body.target); } catch (e) { return json(400, { error: e.message }); }
          }
          const job = startJob(body, {
            headless: cfg.ui?.headlessJobs !== false,
            stallSeconds: cfg.ui?.stallSeconds ?? 180,
          });
          return json(201, { id: job.id, command: job.command, status: job.status, interactive: job.interactive });
        }
        const act = /^\/api\/jobs\/([\w-]+)\/(continue|stop)$/.exec(url.pathname);
        if (act) {
          const ok = act[2] === 'continue' ? sendStdin(act[1]) : stopJob(act[1]);
          return json(ok ? 200 : 409, { ok });
        }
        return json(404, { error: 'not found' });
      }

      // ---------------------------------------------------------- settings
      if (url.pathname === '/api/settings') {
        const dir = cfg.session?.dir ?? 'sessions';
        if (req.method === 'GET') {
          const key = loadSecrets(dir).GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
          return json(200, {
            keyPreview: preview(key),           // never the key itself
            keyFromEnv: !loadSecrets(dir).GEMINI_API_KEY && !!process.env.GEMINI_API_KEY,
            model: cfg.ai?.model ?? '',
            embedModel: cfg.ai?.embedModel ?? '',
            tier: cfg.ai?.tier ?? 'free',
            rpm: cfg.ai?.rpm ?? 15,
            dailyCap: cfg.ai?.dailyCap ?? 1000,
            capabilities: cfg.ai?.capabilities ?? null,
          });
        }
        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const body = await readJson(req);
        if ('apiKey' in body) setSecret('GEMINI_API_KEY', body.apiKey.trim(), dir);
        // Only these config keys may be written from a browser.
        const patch = pick(body, ['model', 'embedModel', 'tier', 'rpm', 'dailyCap']);
        if (Object.keys(patch).length) writeAiConfig(patch);
        Object.assign(cfg.ai ?? (cfg.ai = {}), patch);
        return json(200, { ok: true });
      }

      if (url.pathname === '/api/settings/test') {
        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        return json(200, await probeGemini(cfg));
      }

      // ---------------------------------------- create a site / project
      // Paste a URL, get an audit. Everything else is derived or optional.
      if (url.pathname === '/api/audits' || url.pathname === '/api/groups') {
        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const body = await readJson(req);

        if (url.pathname === '/api/groups') {
          const label = String(body.label ?? '').trim();
          if (!label) return json(400, { error: 'a project needs a name' });
          const id = slugify(label);
          if (!id) return json(400, { error: 'that name has no usable characters' });
          if (cfg.groups?.[id]) return json(409, { error: `project "${id}" already exists` });
          writeConfigPatch((c) => { (c.groups ??= {})[id] = { label, clients: [] }; });
          (cfg.groups ??= {})[id] = { label, clients: [] };
          return json(201, { id, label, clients: [] });
        }

        // ---- new audit: create the client if the URL is new, then run it
        let clientId = body.clientId;
        if (!clientId) {
          const seedUrl = normaliseUrl(body.url);
          if (!seedUrl) return json(400, { error: 'that is not a http(s) address' });
          const existing = Object.entries(cfg.clients ?? {}).find(([, c]) => c.seedUrl === seedUrl);
          if (existing) {
            clientId = existing[0];
          } else {
            clientId = uniqueId(slugify(body.name || new URL(seedUrl).hostname), cfg.clients ?? {});
            const maxPages = Math.min(2000, Math.max(1, Number(body.maxPages) || 25));
            const client = {
              label: String(body.name ?? '').trim() || new URL(seedUrl).hostname,
              seedUrl,
              // Not true and not false: don't interrupt up front, but do stop if
              // we actually walk into a sign-in wall.
              requiresLogin: 'auto',
              // A first audit should finish while you are still watching it.
              crawl: { maxPages },
            };
            const group = body.group && cfg.groups?.[body.group] ? body.group : null;
            writeConfigPatch((c) => {
              (c.clients ??= {})[clientId] = client;
              if (group) (c.groups[group].clients ??= []).push(clientId);
            });
            (cfg.clients ??= {})[clientId] = client;
            if (group) cfg.groups[group].clients.push(clientId);
          }
        }
        if (!cfg.clients?.[clientId]) return json(400, { error: 'unknown client' });
        if (body.start === false) return json(201, { clientId });
        const job = startJob(
          { command: 'run', target: clientId, scope: body.scope },
          { headless: cfg.ui?.headlessJobs !== false, stallSeconds: cfg.ui?.stallSeconds ?? 180 }
        );
        return json(201, { clientId, id: job.id, command: job.command, status: job.status, interactive: job.interactive });
      }

      // ------------------------------ rename / move / pin / delete
      // One route per entity, action in the body. All fenced like every other
      // mutation, and all destructive ones are irreversible — the UI confirms.
      const entity = /^\/api\/(clients|groups|runs)\/(.+)$/.exec(url.pathname);
      if (entity && req.method === 'POST') {
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const [, kind, rawId] = entity;
        const id = decodeURIComponent(rawId);
        const body = await readJson(req);
        try {
          if (kind === 'runs') {
            const db = openDb(dbPath);
            if (body.action === 'pin') pinRun(db, id, body.pinned);
            else if (body.action === 'delete') {
              deleteRun(db, id);
              rmSync(runDir(id), { recursive: true, force: true });
            } else return json(400, { error: 'unknown action' });
            return json(200, { ok: true });
          }

          const apply = {
            clients: {
              rename: (c) => renameClient(c, id, body.label),
              move: (c) => moveClient(c, id, body.group ?? ''),
              pin: (c) => pinClient(c, id, body.pinned),
              delete: (c) => deleteClient(c, id),
            },
            groups: {
              rename: (c) => renameGroup(c, id, body.label),
              pin: (c) => pinGroup(c, id, body.pinned),
              delete: (c) => deleteGroup(c, id),
            },
          }[kind][body.action];
          if (!apply) return json(400, { error: 'unknown action' });

          writeConfigPatch(apply);
          apply(cfg); // keep the in-memory copy in step with the file

          // Deleting a site takes its history with it, or the runs would be orphans.
          if (kind === 'clients' && body.action === 'delete') {
            const db = openDb(dbPath);
            for (const runId of runIdsForClient(db, id)) {
              deleteRun(db, runId);
              rmSync(runDir(runId), { recursive: true, force: true });
            }
          }
          return json(200, { ok: true });
        } catch (err) {
          return json(400, { error: err.message });
        }
      }

      if (url.pathname === '/api/clients') {
        return json(200, {
          clients: Object.entries(cfg.clients ?? {}).map(([id, c]) => ({
            id, label: c.label ?? id, seedUrl: c.seedUrl, requiresLogin: c.requiresLogin !== false,
            // lets the dashboard turn "pages scanned" into real progress
            maxPages: c.crawl?.maxPages ?? cfg.crawl?.maxPages ?? null,
          })),
          groups: groupTree(cfg),
        });
      }

      // --------------------------------------------------- browser mirror
      if (url.pathname === '/api/browser/stream') {
        const job = getJob(url.searchParams.get('job'));
        if (!job?.wsEndpoint) return json(409, { error: 'no browser for that job yet' });
        const ok = await streamBrowser(job.id, job.wsEndpoint, req, res);
        if (!ok) return json(502, { error: 'could not attach to the browser' });
        return;
      }
      if (url.pathname === '/api/browser/input') {
        if (req.method !== 'POST') return json(405, { error: 'POST required' });
        const problem = csrfProblem(req, port);
        if (problem) return json(403, { error: problem });
        const body = await readJson(req);
        const job = getJob(body.job);
        if (!job?.wsEndpoint) return json(409, { error: 'no browser for that job' });
        return json(200, { ok: await forwardInput(job.id, body) });
      }

      // ------------------------------------------------------------- API
      if (url.pathname === '/api/runs') {
        const db = openDb(dbPath);
        return json(200, listRuns(db).map((r) => {
          const findings = getFindings(db, r.id);
          const fixes = getFixes(db, r.id);
          return {
            id: r.id, clientId: r.clientId, seedUrl: r.seedUrl,
            startedAt: r.startedAt, finishedAt: r.finishedAt, pinned: !!r.pinned,
            total: findings.length,
            ai: findings.filter((f) => f.source === 'ai').length,
            critical: findings.filter((f) => f.severity === 'critical').length,
            verified: fixes.filter((f) => f.verification === 'verified').length,
            review: getReviewQueue(db, r.id).length,
          };
        }));
      }

      const findingsRoute = /^\/api\/runs\/(.+)\/findings$/.exec(url.pathname);
      if (findingsRoute) {
        const runId = decodeURIComponent(findingsRoute[1]);
        const report = buildReport(openDb(dbPath), runId);
        // Drop `raw` — it is the biggest field and nothing in the UI reads it.
        return json(200, {
          summary: report.summary,
          findings: report.findings.map(({ raw, ...f }) => ({ ...f, screenshotUrl: shotUrl(f.screenshotPath) })),
        });
      }

      // A client's runs are versions. This is the delta between each adjacent
      // pair, measured by fingerprint — computed in one pass so the history
      // view is a single request, not N diffs.
      const timeline = /^\/api\/timeline\/(.+)$/.exec(url.pathname);
      if (timeline) {
        const clientId = decodeURIComponent(timeline[1]);
        const db = openDb(dbPath);
        const runs = listRuns(db).filter((r) => r.clientId === clientId); // newest first
        const prints = new Map(
          runs.map((r) => [r.id, new Set(getFindings(db, r.id).map((f) => f.fingerprint))])
        );
        return json(200, runs.map((r, i) => {
          const prev = runs[i + 1];
          const head = prints.get(r.id);
          const base = prev ? prints.get(prev.id) : null;
          return {
            id: r.id,
            clientId: r.clientId,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            total: head.size,
            verified: getFixes(db, r.id).filter((f) => f.verification === 'verified').length,
            prev: prev?.id ?? null,
            delta: base && {
              fixed: [...base].filter((f) => !head.has(f)).length,
              new: [...head].filter((f) => !base.has(f)).length,
              stillBroken: [...head].filter((f) => base.has(f)).length,
            },
          };
        }));
      }

      if (url.pathname === '/api/diff') {
        const base = url.searchParams.get('base');
        const head = url.searchParams.get('head');
        if (!base || !head) return json(400, { error: 'need base and head' });
        const d = diffRuns(openDb(dbPath), base, head);
        const trim = (list) => list.map((f) => ({ ruleId: f.ruleId, domSelector: f.domSelector, pageUrl: f.pageUrl, severity: f.severity, wcagCriterion: f.wcagCriterion }));
        return json(200, { counts: d.counts, fixed: trim(d.fixed), new: trim(d.new), stillBroken: trim(d.stillBroken) });
      }

      // ------------------------------------------------- generated files
      if (url.pathname.startsWith('/report/')) {
        const runId = decodeURIComponent(url.pathname.slice('/report/'.length));
        const db = openDb(dbPath);
        const kb = await loadKnowledge({ dir: cfg.ai?.knowledgeDir ?? 'knowledge' });
        const catalogue = criteriaCatalogue(kb);
        writeHtml(db, runId, join(runDir(runId), 'report.html'), catalogue);
        writeJson(db, runId, join(runDir(runId), 'report.json'), catalogue);
        return redirect(`/runs/${encodeURIComponent(runId)}/report.html`);
      }

      if (url.pathname.startsWith('/vpat/')) {
        const runId = decodeURIComponent(url.pathname.slice('/vpat/'.length));
        const kb = await loadKnowledge({ dir: cfg.ai?.knowledgeDir ?? 'knowledge' });
        writeVpat(openDb(dbPath), runId, join(runDir(runId), 'vpat-draft.md'), criteriaCatalogue(kb));
        return redirect(`/runs/${encodeURIComponent(runId)}/vpat-draft.md`);
      }

      if (url.pathname === '/diff') {
        const base = url.searchParams.get('base');
        const head = url.searchParams.get('head');
        if (!base || !head) return send(400, 'need base and head');
        writeDiffHtml(openDb(dbPath), base, head, join(runDir(head), `diff-vs-${base}.html`));
        return redirect(`/runs/${encodeURIComponent(head)}/diff-vs-${encodeURIComponent(base)}.html`);
      }

      // ------------------------------------------------------ run assets
      if (url.pathname.startsWith('/runs/')) {
        const path = safe(rootAbs, decodeURIComponent(url.pathname.slice('/runs/'.length)));
        if (!path) return send(403, 'forbidden');
        if (!existsSync(path) || statSync(path).isDirectory()) return send(404, 'not found');
        return send(200, readFileSync(path), MIME[extname(path)] ?? 'application/octet-stream');
      }

      // ---------------------------------------------------- the app itself
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

  // 127.0.0.1, not 0.0.0.0 — this can start scans, so it stays on this machine.
  server.listen(port, '127.0.0.1', () => {
    console.log(`dashboard → http://localhost:${port}`);
    console.log('  start scans from the dashboard, or keep using the CLI — same commands either way');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(0); });
  return server;
}

/** @returns {string|null} why the request was refused, or null if it is fine */
export function csrfProblem(req, port) {
  // A cross-origin <form> cannot set a custom header, and a cross-origin fetch
  // that tries is stopped by preflight. This one check does most of the work.
  if (req.headers['x-a11y-ui'] !== '1') return 'missing x-a11y-ui header';
  const origin = req.headers.origin;
  if (origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) {
    return `origin ${origin} not allowed`;
  }
  return null;
}

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== '').map((k) => [k, obj[k]]));

/** Patch only the `ai` block of config.json, preserving everything else verbatim. */
function writeAiConfig(patch, path = 'config.json') {
  writeConfigPatch((c) => {
    c.ai = { ...c.ai, ...patch };
    for (const n of ['rpm', 'dailyCap']) if (c.ai[n] != null) c.ai[n] = Number(c.ai[n]);
  }, path);
}

/**
 * Read-modify-write config.json. The file stays the source of truth and stays
 * hand-editable — which is exactly why this is careful: the previous version is
 * kept as config.json.bak, and the new one is written to a temp file and
 * renamed, so an interrupted or racing write can never leave a truncated config.
 */
function writeConfigPatch(mutate, path = 'config.json') {
  const before = readCfg(path, 'utf8');
  const cfg = JSON.parse(before);
  mutate(cfg);
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if (next === before) return;
  writeFileSync(`${path}.bak`, before);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
}

const slugify = (s) =>
  String(s ?? '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function uniqueId(base, taken) {
  const id = base || 'site';
  if (!taken[id]) return id;
  for (let n = 2; ; n++) if (!taken[`${id}-${n}`]) return `${id}-${n}`;
}

/** Accept what a person would paste; refuse anything that is not a real web address. */
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

/**
 * Ask the API what this key can serve, pick the best model for the pipeline,
 * prove it works, and write the result to config. Model names churn — the
 * auditor should never have to know which one is current.
 */
async function probeGemini(cfg) {
  applySecrets(cfg.session?.dir ?? 'sessions');
  const started = Date.now();
  const result = await detectSetup({ ai: cfg.ai, log: () => {} });

  if (result.ok) {
    const patch = { model: result.model, capabilities: result.features };
    if (result.embedModel) patch.embedModel = result.embedModel;
    writeAiConfig(patch);
    Object.assign(cfg.ai ?? (cfg.ai = {}), patch);
  }
  return { ...result, ms: Date.now() - started, autoConfigured: result.ok };
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

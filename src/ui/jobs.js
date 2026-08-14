// Job runner for the dashboard. Spawns the CLI as a child process rather than
// calling the pipeline in-process: the CLI is already the tested entry point,
// a crash cannot take the server down, stop = kill, and the manual-login
// prompt keeps working because we own the child's stdin.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_LINES = 3000;
const jobs = new Map();

/** Only these can ever be spawned. No free-form commands from a browser. */
export const COMMANDS = {
  // The one the dashboard uses: a client or a group, with a scope.
  run: {
    args: (o) => ['run', o.target, `--scope=${['scan', 'assess', 'full'].includes(o.scope) ? o.scope : 'scan'}`],
    needsTarget: true,
  },
  login: { args: (o) => ['login', o.clientId], needsClient: true, interactive: true },
  scan: { args: (o) => ['scan', o.clientId], needsClient: true },
  assess: { args: (o) => ['assess', o.clientId, o.runId], needsClient: true, needsRun: true },
  audit: { args: (o) => ['audit', o.clientId], needsClient: true },
};

// Everything unserialisable must be named here: a Timeout holds a circular
// reference to the timer list and turns this endpoint into a 500.
export const listJobs = () =>
  [...jobs.values()].map(({ child, subs, lines, stallTimer, bumpStall, ...j }) => ({ ...j, lineCount: lines.length }));

export const getJob = (id) => jobs.get(id) ?? null;

export function startJob(
  { command, clientId, runId, target, scope },
  { cwd = process.cwd(), headless = true, stallSeconds = 180 } = {}
) {
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`unknown command "${command}"`);
  if (spec.needsClient && !clientId) throw new Error('clientId required');
  if (spec.needsRun && !runId) throw new Error('runId required');
  if (spec.needsTarget && !target) throw new Error('target required');

  const job = {
    id: randomUUID().slice(0, 8),
    command,
    clientId: clientId ?? target ?? null,
    target: target ?? null,
    scope: scope ?? null,
    runId: runId ?? null,
    status: 'running',
    interactive: !!spec.interactive,
    // Set from the markers the pipeline prints on stdout.
    wsEndpoint: null,
    needsLogin: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    lines: [],
    subs: new Set(),
  };

  const child = spawn(process.execPath, ['src/cli.js', ...spec.args({ clientId, runId, target, scope })], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Jobs started from the dashboard run headless: the browser lives in the
    // app's own panel. A second Chrome window is confusing, and a backgrounded
    // headed window stops painting, which silently kills the mirror.
    env: { ...process.env, FORCE_COLOR: '0', ...(headless ? { A11Y_HEADLESS: '1' } : {}) },
  });
  job.child = child;
  jobs.set(job.id, job);

  // A hung page, a wedged Lighthouse run or a model that never answers all look
  // the same from out here: silence. Say so instead of spinning forever.
  const bumpStall = () => {
    clearTimeout(job.stallTimer);
    if (job.status !== 'running') return;
    job.stalled = false;
    job.stallTimer = setTimeout(() => {
      job.stalled = true;
      emit(job, { type: 'stalled', seconds: stallSeconds, since: job.lastOutputAt });
    }, stallSeconds * 1000);
  };
  job.lastOutputAt = Date.now();
  bumpStall();
  job.bumpStall = bumpStall;

  const push = (text, stream = 'out') => {
    job.lastOutputAt = Date.now();
    if (job.stalled) emit(job, { type: 'unstalled' });
    bumpStall();
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.lines.push({ stream, line, at: Date.now() });
      if (job.lines.length > MAX_LINES) job.lines.shift();
      readMarker(job, line);
      emit(job, { type: 'line', stream, line });
    }
  };

  child.stdout.on('data', (d) => push(d));
  child.stderr.on('data', (d) => push(d, 'err'));
  child.on('error', (err) => push(`spawn failed: ${err.message}`, 'err'));
  child.on('close', (code) => {
    clearTimeout(job.stallTimer);
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    emit(job, { type: 'status', status: job.status, exitCode: code });
    for (const res of job.subs) res.end();
    job.subs.clear();
  });

  return job;
}

/** The manual-login step waits on Enter — this is the auditor pressing it. */
export function sendStdin(id, data = '\n') {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.child.stdin.write(data);
  emit(job, { type: 'line', stream: 'out', line: '[continue signalled from dashboard]' });
  return true;
}

export function stopJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  clearTimeout(job.stallTimer);
  job.child.kill();
  job.status = 'stopped';
  emit(job, { type: 'status', status: 'stopped' });
  return true;
}

export function subscribe(id, res) {
  const job = jobs.get(id);
  if (!job) return false;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Replay what already happened, so a late subscriber sees the whole log.
  for (const l of job.lines) res.write(sse({ type: 'line', stream: l.stream, line: l.line }));
  if (job.wsEndpoint) res.write(sse({ type: 'browser', wsEndpoint: job.wsEndpoint }));
  if (job.needsLogin) res.write(sse({ type: 'needs-login', ...job.needsLogin }));
  res.write(sse({ type: 'status', status: job.status, exitCode: job.exitCode }));
  if (job.status !== 'running') return res.end(), true;
  job.subs.add(res);
  res.on('close', () => job.subs.delete(res));
  return true;
}

/**
 * The pipeline talks to the dashboard through stdout markers. Keeping it to a
 * one-way text channel means the CLI stays the single tested entry point and
 * nothing needs an IPC protocol.
 */
function readMarker(job, line) {
  const ws = /^\[browser-ws\]\s+(\S+)/.exec(line);
  if (ws) {
    job.wsEndpoint = ws[1];
    emit(job, { type: 'browser', wsEndpoint: ws[1] });
    return;
  }
  const login = /^\[needs-login\]\s+(\S+)\s*::\s*(.*)$/.exec(line);
  if (login) {
    job.needsLogin = { url: login[1], why: login[2] };
    emit(job, { type: 'needs-login', url: login[1], why: login[2] });
    return;
  }
  const blocked = /^\[blocked\]\s+(\S+)\s*::\s*(.*)$/.exec(line);
  if (blocked) {
    job.blocked = { url: blocked[1], why: blocked[2] };
    emit(job, { type: 'blocked', url: blocked[1], why: blocked[2] });
    return;
  }
  if (/^\[login-ok\]/.test(line)) {
    job.needsLogin = null;
    emit(job, { type: 'login-ok' });
    return;
  }
  const stage = /^\[(stage|site|target|done)\]\s*(.*)$/.exec(line);
  if (stage) emit(job, { type: 'stage', stage: stage[1], detail: stage[2] });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const emit = (job, obj) => {
  for (const res of job.subs) res.write(sse(obj));
};

export function killAll() {
  for (const job of jobs.values()) if (job.status === 'running') job.child.kill();
}

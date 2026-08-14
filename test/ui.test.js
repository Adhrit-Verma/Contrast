// The dashboard can start a real scan against a client site. That makes these
// two functions a security boundary, so they get tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csrfProblem } from '../src/ui/server.js';
import { COMMANDS, startJob, listJobs } from '../src/ui/jobs.js';
import { resolveTarget, groupTree } from '../src/config.js';

const req = (headers) => ({ headers });

test('csrfProblem rejects anything a cross-origin page could send', () => {
  // A cross-origin <form> POST cannot set a custom header at all.
  assert.match(csrfProblem(req({}), 4321), /missing x-a11y-ui/);
  assert.match(csrfProblem(req({ origin: 'https://evil.example' }), 4321), /missing x-a11y-ui/);
  // Even with the header, a foreign origin is refused.
  assert.match(
    csrfProblem(req({ 'x-a11y-ui': '1', origin: 'https://evil.example' }), 4321),
    /origin https:\/\/evil\.example not allowed/
  );
});

test('csrfProblem allows the dashboard itself, on either loopback name', () => {
  assert.equal(csrfProblem(req({ 'x-a11y-ui': '1', origin: 'http://localhost:4321' }), 4321), null);
  assert.equal(csrfProblem(req({ 'x-a11y-ui': '1', origin: 'http://127.0.0.1:4321' }), 4321), null);
  assert.equal(csrfProblem(req({ 'x-a11y-ui': '1' }), 4321), null); // same-origin fetch sends no Origin
});

test('only the known commands can ever be spawned', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), ['assess', 'audit', 'login', 'run', 'scan']);
  assert.throws(() => startJob({ command: 'rm -rf /', clientId: 'demo' }), /unknown command/);
  assert.throws(() => startJob({ command: 'scan' }), /clientId required/);
  assert.throws(() => startJob({ command: 'assess', clientId: 'demo' }), /runId required/);
  assert.throws(() => startJob({ command: 'run' }), /target required/);
});

test('the job list stays JSON-serialisable', () => {
  // A Timeout or a function on the job object turns GET /api/jobs into a 500
  // with "Converting circular structure to JSON".
  assert.doesNotThrow(() => JSON.stringify(listJobs()));
  for (const j of listJobs()) {
    for (const [k, v] of Object.entries(j)) {
      assert.ok(typeof v !== 'function', `${k} must not be a function`);
      assert.ok(!(v && typeof v === 'object' && 'ref' in v && 'unref' in v), `${k} looks like a Timer`);
    }
  }
});

test('command arguments are positional, never interpolated into a shell', () => {
  // spawn() with an argv array means a client id can never become a command.
  assert.deepEqual(COMMANDS.scan.args({ clientId: 'a; rm -rf /' }), ['scan', 'a; rm -rf /']);
  assert.deepEqual(COMMANDS.assess.args({ clientId: 'c', runId: 'r' }), ['assess', 'c', 'r']);
  assert.deepEqual(COMMANDS.run.args({ target: 'grp', scope: 'assess' }), ['run', 'grp', '--scope=assess']);
});

test('an unknown scope can never reach the CLI', () => {
  // The scope lands in an argv string, so it is whitelisted rather than trusted.
  assert.deepEqual(COMMANDS.run.args({ target: 'g', scope: '; rm -rf /' }), ['run', 'g', '--scope=scan']);
  assert.deepEqual(COMMANDS.run.args({ target: 'g' }), ['run', 'g', '--scope=scan']);
});

test('groups resolve to their member clients, unknown targets are refused', () => {
  const cfg = {
    clients: { a: {}, b: {}, loose: {} },
    groups: { acme: { label: 'Acme', clients: ['a', 'b', 'ghost'] } },
  };
  assert.deepEqual(resolveTarget(cfg, 'acme').clientIds, ['a', 'b']); // ghost is not a client
  assert.equal(resolveTarget(cfg, 'a').kind, 'client');
  assert.throws(() => resolveTarget(cfg, 'nope'), /neither a client nor a group/);
  assert.throws(() => resolveTarget({ clients: {}, groups: { empty: { clients: [] } } }, 'empty'), /no known clients/);
  // ungrouped clients still show up in the tree
  assert.deepEqual(groupTree(cfg).map((g) => g.id), ['acme', '__ungrouped']);
  assert.deepEqual(groupTree(cfg).at(-1).clients, ['loose']);
});

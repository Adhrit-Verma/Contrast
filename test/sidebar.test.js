// Rename / move / pin / delete are destructive and edit the user's config file,
// so the logic lives in pure functions and gets tested without touching disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renameClient, moveClient, pinClient, deleteClient,
  renameGroup, pinGroup, deleteGroup, groupTree,
} from '../src/config.js';

const fixture = () => ({
  clients: { a: { label: 'A' }, b: { label: 'B' }, loose: { label: 'Loose' } },
  groups: { acme: { label: 'Acme', clients: ['a', 'b'] }, other: { label: 'Other', clients: [] } },
});

test('rename refuses an empty name for sites and projects alike', () => {
  assert.throws(() => renameClient(fixture(), 'a', '   '), /needs a name/);
  assert.throws(() => renameGroup(fixture(), 'acme', ''), /needs a name/);
  assert.equal(renameClient(fixture(), 'a', ' Alpha ').clients.a.label, 'Alpha');
});

test('unknown ids are refused rather than silently creating entries', () => {
  assert.throws(() => renameClient(fixture(), 'ghost', 'x'), /no site "ghost"/);
  assert.throws(() => moveClient(fixture(), 'a', 'ghost'), /no project "ghost"/);
  assert.throws(() => deleteGroup(fixture(), 'ghost'), /no project "ghost"/);
});

test('moving a site never leaves it in two projects', () => {
  const cfg = moveClient(fixture(), 'a', 'other');
  assert.deepEqual(cfg.groups.acme.clients, ['b']);
  assert.deepEqual(cfg.groups.other.clients, ['a']);
  const out = moveClient(cfg, 'a', '');
  assert.deepEqual(out.groups.other.clients, []);
  assert.ok(out.clients.a, 'the site itself survives being ungrouped');
});

test('deleting a project keeps its sites — only the grouping goes', () => {
  const cfg = deleteGroup(fixture(), 'acme');
  assert.equal(cfg.groups.acme, undefined);
  assert.ok(cfg.clients.a && cfg.clients.b);
  // and they resurface as ungrouped rather than vanishing from the tree
  assert.deepEqual(groupTree(cfg).at(-1).clients.sort(), ['a', 'b', 'loose']);
});

test('deleting a site removes it from every project that referenced it', () => {
  const cfg = deleteClient(fixture(), 'a');
  assert.equal(cfg.clients.a, undefined);
  assert.deepEqual(cfg.groups.acme.clients, ['b']);
});

test('pinning is a toggle that leaves no residue when unset', () => {
  let cfg = pinClient(fixture(), 'b', true);
  assert.equal(cfg.clients.b.pinned, true);
  cfg = pinClient(cfg, 'b', false);
  assert.ok(!('pinned' in cfg.clients.b), 'unpinning removes the key rather than writing false');
  cfg = pinGroup(cfg, 'other', true);
  assert.equal(cfg.groups.other.pinned, true);
});

test('pinned items sort to the top of the tree', () => {
  let cfg = pinGroup(fixture(), 'other', true);
  cfg = pinClient(cfg, 'b', true);
  const tree = groupTree(cfg);
  assert.equal(tree[0].id, 'other', 'pinned project first');
  assert.deepEqual(tree.find((g) => g.id === 'acme').clients, ['b', 'a'], 'pinned site first');
});

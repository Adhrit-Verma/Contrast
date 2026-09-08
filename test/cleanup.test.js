import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, insert } from '../src/db.js';
import { cleanupOldRuns } from '../src/public/cleanup.js';
import { runDir } from '../src/scan/index.js';

test('cleanupOldRuns removes only runs older than the cutoff, db row and folder both', () => {
  const dbPath = `runs/__test-cleanup-${randomUUID()}.sqlite`;
  const db = openDb(dbPath);
  const oldId = `old-${randomUUID()}`;
  const newId = `new-${randomUUID()}`;
  insert(db, 'runs', { id: oldId, clientId: 'x', seedUrl: 'https://old.example', startedAt: new Date(Date.now() - 20 * 86400000).toISOString() });
  insert(db, 'runs', { id: newId, clientId: 'x', seedUrl: 'https://new.example', startedAt: new Date().toISOString() });
  mkdirSync(runDir(oldId), { recursive: true });
  mkdirSync(runDir(newId), { recursive: true });

  try {
    const deleted = cleanupOldRuns(db, 15);
    assert.equal(deleted, 1);
    assert.equal(db.prepare('SELECT id FROM runs WHERE id = ?').get(oldId), undefined);
    assert.ok(db.prepare('SELECT id FROM runs WHERE id = ?').get(newId));
    assert.equal(existsSync(runDir(oldId)), false);
    assert.equal(existsSync(runDir(newId)), true);
  } finally {
    rmSync(runDir(newId), { recursive: true, force: true });
    db.close(); // Windows holds the file open otherwise, and rmSync below fails
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
});

test('cleanupOldRuns is a no-op when nothing is old enough', () => {
  const dbPath = `runs/__test-cleanup-${randomUUID()}.sqlite`;
  const db = openDb(dbPath);
  const id = `fresh-${randomUUID()}`;
  insert(db, 'runs', { id, clientId: 'x', seedUrl: 'https://fresh.example', startedAt: new Date().toISOString() });
  try {
    assert.equal(cleanupOldRuns(db, 15), 0);
    assert.ok(db.prepare('SELECT id FROM runs WHERE id = ?').get(id));
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
});

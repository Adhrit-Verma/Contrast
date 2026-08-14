// SQLite via node:sqlite (Node >= 22.5) — no native build, no ORM, no dep.
// Emits an ExperimentalWarning on Node 24; harmless.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, clientId TEXT, seedUrl TEXT,
  startedAt TEXT, finishedAt TEXT, config TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  runId TEXT, url TEXT, finalUrl TEXT, title TEXT, status INTEGER,
  screenshotPath TEXT, a11yTree TEXT, error TEXT,
  PRIMARY KEY (runId, url)
);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, runId TEXT, fingerprint TEXT, pageUrl TEXT, timestamp TEXT,
  source TEXT, wcagCriterion TEXT, wcagLevel TEXT, severity TEXT, ruleId TEXT,
  domSelector TEXT, htmlSnippet TEXT, computedStyles TEXT, screenshotPath TEXT,
  description TEXT, confidence REAL, helpUrl TEXT, raw TEXT
);
CREATE INDEX IF NOT EXISTS findings_run ON findings (runId);
CREATE INDEX IF NOT EXISTS findings_fp ON findings (fingerprint);
CREATE TABLE IF NOT EXISTS fixes (
  id TEXT PRIMARY KEY, runId TEXT, findingId TEXT, attempts INTEGER,
  before TEXT, after TEXT, explanation TEXT, verification TEXT, verifyNotes TEXT,
  model TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS ai_cache (
  hash TEXT PRIMARY KEY, task TEXT, model TEXT, response TEXT, createdAt TEXT
);
CREATE TABLE IF NOT EXISTS review_queue (
  id TEXT PRIMARY KEY, runId TEXT, findingId TEXT, reason TEXT, context TEXT, createdAt TEXT
);
`;

export function openDb(path = 'runs/audit.sqlite') {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Added after the first schema shipped; CREATE TABLE IF NOT EXISTS will not
  // add it to an existing database, so ask forgiveness rather than permission.
  try { db.exec('ALTER TABLE runs ADD COLUMN pinned INTEGER DEFAULT 0'); } catch {}
  return db;
}

export const pinRun = (db, runId, pinned) =>
  db.prepare('UPDATE runs SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, runId);

/** A run is rows in five tables plus a folder of screenshots. Take all of it. */
export function deleteRun(db, runId) {
  for (const t of ['findings', 'pages', 'fixes', 'review_queue']) {
    db.prepare(`DELETE FROM ${t} WHERE runId = ?`).run(runId);
  }
  db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
}

/** Every run belonging to a site, for when the site itself is deleted. */
export const runIdsForClient = (db, clientId) =>
  db.prepare('SELECT id FROM runs WHERE clientId = ?').all(clientId).map((r) => r.id);

const cols = (row) => Object.keys(row);
const json = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

export function insert(db, table, row) {
  const keys = cols(row);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => (typeof row[k] === 'object' ? json(row[k]) : row[k] ?? null)));
}

export function insertFindings(db, findings) {
  for (const f of findings) {
    insert(db, 'findings', {
      id: f.id, runId: f.runId, fingerprint: f.fingerprint, pageUrl: f.pageUrl, timestamp: f.timestamp,
      source: f.source, wcagCriterion: f.wcagCriterion, wcagLevel: f.wcagLevel, severity: f.severity,
      ruleId: f.ruleId, domSelector: f.domSelector, htmlSnippet: f.htmlSnippet,
      computedStyles: json(f.computedStyles), screenshotPath: f.screenshotPath,
      description: f.description, confidence: f.confidence, helpUrl: f.helpUrl, raw: json(f.raw),
    });
  }
}

const revive = (r) => ({
  ...r,
  computedStyles: r.computedStyles ? JSON.parse(r.computedStyles) : null,
  raw: r.raw ? JSON.parse(r.raw) : null,
});

export const getFindings = (db, runId) =>
  db.prepare('SELECT * FROM findings WHERE runId = ? ORDER BY pageUrl, severity').all(runId).map(revive);

export const getRun = (db, runId) => db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
export const getPages = (db, runId) => db.prepare('SELECT * FROM pages WHERE runId = ?').all(runId);
export const getFixes = (db, runId) => db.prepare('SELECT * FROM fixes WHERE runId = ?').all(runId);
export const getReviewQueue = (db, runId) => db.prepare('SELECT * FROM review_queue WHERE runId = ?').all(runId);
export const listRuns = (db) =>
  db.prepare('SELECT * FROM runs ORDER BY pinned DESC, startedAt DESC').all();

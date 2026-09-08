// Keeps the public funnel's own storage bounded — the admin dashboard's runs
// (audit.sqlite) are never touched by this, it only ever runs against
// runs/public.sqlite.
import { rmSync } from 'node:fs';
import { deleteRun } from '../db.js';
import { runDir } from '../scan/index.js';

/** Deletes public.sqlite rows + the on-disk run folder for every run started
 *  more than `days` ago. Returns how many were removed. */
export function cleanupOldRuns(db, days = 15) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const old = db.prepare('SELECT id FROM runs WHERE startedAt < ?').all(cutoff);
  for (const { id } of old) {
    deleteRun(db, id);
    rmSync(runDir(id), { recursive: true, force: true });
  }
  return old.length;
}

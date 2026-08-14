// The auditor's own API key — not client credentials, which are never stored at
// all. Kept encrypted at rest with the same AES-256-GCM vault as sessions, so a
// key never lands in config.json (which people commit) or in shell history.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { seal, unseal, sessionKey } from './browser/session.js';

const file = (dir) => join(dir, '.secrets.json');

export function loadSecrets(dir = 'sessions') {
  const path = file(dir);
  if (!existsSync(path)) return {};
  try {
    return unseal(JSON.parse(readFileSync(path, 'utf8')), sessionKey(dir));
  } catch {
    return {};
  }
}

export function setSecret(name, value, dir = 'sessions') {
  const all = loadSecrets(dir);
  if (value) all[name] = value;
  else delete all[name];
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify(seal(all, sessionKey(dir)), null, 2), { mode: 0o600 });
  applySecrets(dir);
  return Object.keys(all);
}

/** A real env var always wins — CI and shell exports must not be overridden. */
export function applySecrets(dir = 'sessions') {
  for (const [k, v] of Object.entries(loadSecrets(dir))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

/** Never send a key back to a browser. Show enough to recognise it, no more. */
export const preview = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)` : null);

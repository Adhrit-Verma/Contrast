import { readFileSync } from 'node:fs';

export function loadConfig(path = 'config.json') {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * A target is either one client or a group of them. Groups exist so an auditor
 * can run "the whole Acme estate" as one job instead of remembering six ids.
 * @returns {{kind: 'group'|'client', id: string, label: string, clientIds: string[]}}
 */
export function resolveTarget(cfg, name) {
  const group = cfg.groups?.[name];
  if (group) {
    const clientIds = (group.clients ?? []).filter((id) => cfg.clients?.[id]);
    if (!clientIds.length) throw new Error(`group "${name}" has no known clients`);
    return { kind: 'group', id: name, label: group.label ?? name, clientIds };
  }
  if (cfg.clients?.[name]) return { kind: 'client', id: name, label: name, clientIds: [name] };
  throw new Error(`"${name}" is neither a client nor a group in config.json`);
}

/** Groups with their members, for the sidebar. Ungrouped clients land in "Ungrouped". */
export function groupTree(cfg) {
  const grouped = new Set();
  const pinFirst = (ids) =>
    [...ids].sort((a, b) => (cfg.clients?.[b]?.pinned ? 1 : 0) - (cfg.clients?.[a]?.pinned ? 1 : 0));
  const groups = Object.entries(cfg.groups ?? {}).map(([id, g]) => {
    (g.clients ?? []).forEach((c) => grouped.add(c));
    return {
      id,
      label: g.label ?? id,
      pinned: !!g.pinned,
      clients: pinFirst((g.clients ?? []).filter((c) => cfg.clients?.[c])),
    };
  });
  groups.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  const loose = Object.keys(cfg.clients ?? {}).filter((c) => !grouped.has(c));
  if (loose.length) groups.push({ id: '__ungrouped', label: 'Ungrouped', pinned: false, clients: pinFirst(loose) });
  return groups;
}

// ---------------------------------------------------------------------------
// Sidebar mutations. Pure functions over a parsed config object so they can be
// tested without touching the disk; the server wraps them in a read-write.
// Each throws with a message meant for a human, and never leaves a dangling
// reference between groups and clients.
// ---------------------------------------------------------------------------

const requireClient = (cfg, id) => {
  if (!cfg.clients?.[id]) throw new Error(`no site "${id}"`);
  return cfg.clients[id];
};
const requireGroup = (cfg, id) => {
  if (!cfg.groups?.[id]) throw new Error(`no project "${id}"`);
  return cfg.groups[id];
};

export function renameClient(cfg, id, label) {
  const name = String(label ?? '').trim();
  if (!name) throw new Error('a site needs a name');
  requireClient(cfg, id).label = name;
  return cfg;
}

/** `group` of '' or null means ungrouped. A client belongs to at most one. */
export function moveClient(cfg, id, group) {
  requireClient(cfg, id);
  if (group) requireGroup(cfg, group);
  for (const g of Object.values(cfg.groups ?? {})) {
    g.clients = (g.clients ?? []).filter((c) => c !== id);
  }
  if (group) (cfg.groups[group].clients ??= []).push(id);
  return cfg;
}

export function pinClient(cfg, id, pinned) {
  const client = requireClient(cfg, id);
  if (pinned) client.pinned = true;
  else delete client.pinned;
  return cfg;
}

export function deleteClient(cfg, id) {
  requireClient(cfg, id);
  delete cfg.clients[id];
  for (const g of Object.values(cfg.groups ?? {})) {
    g.clients = (g.clients ?? []).filter((c) => c !== id);
  }
  return cfg;
}

export function renameGroup(cfg, id, label) {
  const name = String(label ?? '').trim();
  if (!name) throw new Error('a project needs a name');
  requireGroup(cfg, id).label = name;
  return cfg;
}

export function pinGroup(cfg, id, pinned) {
  const group = requireGroup(cfg, id);
  if (pinned) group.pinned = true;
  else delete group.pinned;
  return cfg;
}

/** Deleting a project never deletes its sites — they fall back to Ungrouped. */
export function deleteGroup(cfg, id) {
  requireGroup(cfg, id);
  delete cfg.groups[id];
  return cfg;
}

/** Merged view for one client: top-level defaults + client overrides. */
export function clientConfig(cfg, clientId) {
  const client = cfg.clients?.[clientId];
  if (!client) throw new Error(`Unknown client "${clientId}". Add it to config.json under "clients".`);
  return {
    id: clientId,
    ...client,
    // A11Y_HEADLESS=1 (set for every job the dashboard spawns) is the default,
    // but an explicit per-client `browser.headless` wins over it: sites behind
    // bot protection only answer a real browser window, and that is a legitimate
    // setting rather than an evasion.
    browser: { ...cfg.browser, ...(process.env.A11Y_HEADLESS ? { headless: true } : {}), ...client.browser },
    session: { ...cfg.session, ...client.session },
    crawl: { ...cfg.crawl, ...client.crawl },
    scan: { ...cfg.scan, ...client.scan },
    ai: { ...cfg.ai, ...client.ai },
    report: { ...cfg.report, ...client.report },
    db: { ...cfg.db, ...client.db },
  };
}

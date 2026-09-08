// Contrast — funnel monitoring. Standalone page, same design system as the
// admin dashboard (tokens.css/app.css served straight from src/ui/public/ by
// src/funnel/server.js) but its own small script — no shared state, no
// sidebar, no client/run concept. Just this service's own data.
//
// Charts are hand-rolled inline SVG on purpose: no build step exists here, and
// the only colours used are (a) the brand accent for single-series magnitude
// and (b) the product's own severity tokens, which always ship beside their
// label. There is no categorical palette, so no series colour ever has to
// carry identity on its own.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const post = async (p, body) => {
  const r = await fetch(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-a11y-ui': '1' },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `${p} → ${r.status}`);
  return d;
};

const toast = (msg) => {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 200);
  }, 2600);
};

/** Same dialog as the dashboard's — see src/ui/public/app.js for why it exists
 *  instead of native prompt()/confirm(). Duplicated, not shared, to keep this
 *  page standalone. */
function ask({ title, body = '', label = null, value = '', confirmText = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const from = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal card" role="dialog" aria-modal="true" aria-labelledby="ask-t">
      <h2 id="ask-t">${esc(title)}</h2>
      ${body ? `<p>${body}</p>` : ''}
      ${label ? `<label class="field" style="margin-bottom:16px"><span>${esc(label)}</span>
        <input type="text" id="ask-input" value="${esc(value)}"></label>` : ''}
      <div class="row">
        <button class="btn ${danger ? 'danger' : 'primary'}" id="ask-ok">${esc(confirmText)}</button>
        <button class="btn" id="ask-cancel">Cancel</button>
      </div></div>`;
    document.body.append(back);
    const input = $('#ask-input', back);
    const done = (val) => { back.remove(); from?.focus?.(); resolve(val); };
    $('#ask-ok', back).addEventListener('click', () => done(input ? input.value.trim() || null : true));
    $('#ask-cancel', back).addEventListener('click', () => done(null));
    back.addEventListener('click', (e) => e.target === back && done(null));
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      if (e.key === 'Enter' && input) { e.preventDefault(); done(input.value.trim() || null); }
    });
    (input ?? $('#ask-ok', back)).focus();
    input?.select();
  });
}

// ------------------------------------------------------------- formatting

const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;
const num = (n) => (n ?? 0).toLocaleString();
const bytes = (b) => {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${(s ?? 0).toFixed(1)}s`);
const when = (t) => esc(String(t ?? '').slice(0, 16).replace('T', ' '));

// ----------------------------------------------------------------- charts
// One tooltip element for every chart; marks carry data-tip and the handler is
// delegated, so adding a chart never means adding another listener.

function mountTips() {
  let tip = $('#tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tip';
    tip.hidden = true;
    document.body.append(tip);
  }
  document.addEventListener('mousemove', (e) => {
    const mark = e.target.closest?.('[data-tip]');
    if (!mark) { tip.hidden = true; return; }
    tip.textContent = mark.dataset.tip;
    tip.hidden = false;
    // Keep it on screen near the cursor without ever sitting under it.
    const pad = 14;
    tip.style.left = `${Math.min(e.clientX + pad, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - pad)}px`;
  });
}

/**
 * Change over time, one series. No legend — the heading names it. Only the
 * peak is labelled; a number on every point is noise.
 */
function areaChart(points, { label = 'value', height = 160 } = {}) {
  if (!points.length) return '<p class="dim">No data yet.</p>';
  const W = 720, H = height, PAD = { t: 14, r: 12, b: 22, l: 34 };
  const max = Math.max(1, ...points.map((p) => p.n));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (n) => PAD.t + ih - (n / max) * ih;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${PAD.t + ih} L${x(0).toFixed(1)},${PAD.t + ih} Z`;
  const peak = points.reduce((a, b) => (b.n > a.n ? b : a), points[0]);
  const peakIdx = points.indexOf(peak);

  // Three recessive gridlines is enough to read a magnitude off.
  const grid = [0, 0.5, 1].map((f) => {
    const gy = PAD.t + ih - f * ih;
    return `<line x1="${PAD.l}" y1="${gy}" x2="${W - PAD.r}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>
      <text x="${PAD.l - 6}" y="${gy + 4}" text-anchor="end" font-size="10" fill="var(--text-3)">${Math.round(max * f)}</text>`;
  }).join('');

  const hit = points.map((p, i) => `<rect x="${(x(i) - iw / points.length / 2).toFixed(1)}" y="${PAD.t}"
      width="${(iw / points.length).toFixed(1)}" height="${ih}" fill="transparent"
      data-tip="${esc(p.day)} — ${p.n} ${esc(label)}"/>`).join('');

  const table = `<details style="margin-top:var(--s-2)">
    <summary class="dim" style="cursor:pointer;font-size:var(--fs-xs)">Table view</summary>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table class="data"><thead><tr><th>Day</th><th>${esc(label)}</th></tr></thead>
    <tbody>${points.map((p) => `<tr><td>${esc(p.day)}</td><td>${p.n}</td></tr>`).join('')}</tbody></table></div>
  </details>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
      aria-label="${esc(label)} per day. Peak ${peak.n} on ${esc(peak.day)}. ${points.length} days shown.">
    ${grid}
    <path d="${area}" fill="var(--accent)" opacity=".12"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(peakIdx).toFixed(1)}" cy="${y(peak.n).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    <text x="${x(peakIdx).toFixed(1)}" y="${(y(peak.n) - 10).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text-2)">${peak.n}</text>
    <text x="${PAD.l}" y="${H - 6}" font-size="10" fill="var(--text-3)">${esc(points[0].day)}</text>
    <text x="${W - PAD.r}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--text-3)">${esc(points.at(-1).day)}</text>
    ${hit}
  </svg>${table}`;
}

// Every tone must name a token that actually exists. Building the custom
// property by string concatenation (`--sev-${tone}-fg`) silently yields an
// invalid colour for anything outside the severity scale, and an invalid fill
// paints nothing at all — a bar that reads as zero no matter its value.
const TONE = {
  critical: 'var(--sev-critical-fg)', serious: 'var(--sev-serious-fg)',
  moderate: 'var(--sev-moderate-fg)', minor: 'var(--sev-minor-fg)',
  ok: 'var(--ok)', accent: 'var(--accent)',
};

/**
 * Magnitude across named things. One hue — the label carries identity, the bar
 * carries the quantity. A row may name a status tone instead, which is only
 * ever used where the word is right there beside it.
 */
function bars(rows, { unit = '' } = {}) {
  if (!rows.length) return '<p class="dim">No data yet.</p>';
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row" style="grid-template-columns:minmax(96px,auto) 1fr auto">
      <span class="badge${r.badge ? ` ${r.badge}` : ''}" style="white-space:nowrap">${esc(r.label)}</span>
      <span class="bar" data-tip="${esc(r.label)}: ${num(r.n)}${esc(unit)}">
        <i style="width:${(r.n / max) * 100}%;background:${TONE[r.tone] ?? TONE.accent}"></i></span>
      <span class="n mono">${num(r.n)}</span>
    </div>`).join('')}</div>`;
}

/** Stages of one journey, each a share of the one above it. Not a pie, not a
 *  literal funnel shape — just aligned bars, which is the readable form. */
function funnelChart(stages) {
  const top = Math.max(1, stages[0]?.n ?? 1);
  return `<div class="bars" role="img" aria-label="${esc(stages.map((s) => `${s.label}: ${s.n}`).join('; '))}">
    ${stages.map((s, i) => `<div class="funnel-stage">
      <div class="funnel-head">
        <b>${esc(s.label)}</b>
        <span class="mono">${num(s.n)}<span class="dim" style="font-weight:400"> · ${pct(s.n / top)}</span></span>
      </div>
      <span class="bar" data-tip="${esc(s.label)}: ${num(s.n)} (${pct(s.n / top)} of ${esc(stages[0].label)})">
        <i style="width:${(s.n / top) * 100}%"></i></span>
      ${i < stages.length - 1 ? `<span class="funnel-drop dim">↓ ${stages[i + 1].n ? pct(stages[i + 1].n / (s.n || 1)) : '0%'} continue</span>` : ''}
    </div>`).join('')}
  </div>`;
}

/** 24 slots, one per hour. Magnitude only, so a single hue and no legend. */
function hourChart(byHour) {
  const counts = Array.from({ length: 24 }, (_, h) => byHour.find((r) => r.hour === h)?.n ?? 0);
  const max = Math.max(1, ...counts);
  if (!counts.some(Boolean)) return '<p class="dim">No data yet.</p>';
  return `<div class="hours" role="img" aria-label="Scans by hour of day, UTC. ${counts.map((n, h) => `${h}:00 ${n}`).join(', ')}">
    ${counts.map((n, h) => `<div class="hour">
      <span class="hour-bar" data-tip="${String(h).padStart(2, '0')}:00 UTC — ${n} scan${n === 1 ? '' : 's'}">
        <i style="height:${n ? Math.max(6, (n / max) * 100) : 0}%"></i></span>
      <span class="hour-tick dim">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>
    </div>`).join('')}
  </div>`;
}

const SEV_ORDER = ['critical', 'serious', 'moderate', 'minor'];
const OUTCOME_TONE = { completed: 'ok', blocked: 'moderate', errored: 'critical', running: 'minor' };

// ------------------------------------------------------------------ state

const state = { tab: 'overview', table: 'runs', offset: 0, data: null };
const TABS = [
  ['overview', 'Overview'], ['audience', 'Audience'], ['scans', 'Scans'],
  ['incidents', 'Incidents & rules'], ['database', 'Database'],
];

async function loadAll() {
  const [summary, runs, incidents, rules, tables, auth] = await Promise.all([
    api('/api/summary'), api('/api/runs?limit=40'), api('/api/incidents'),
    api('/api/rules'), api('/api/tables'), api('/api/auth'),
  ]);
  state.data = { summary, runs: runs.runs, incidents: incidents.incidents, rules: rules.rules, tables, auth };
}

async function render() {
  const el = $('#content');
  if (!state.data) {
    el.innerHTML = '<div class="skeleton" style="height:260px"></div>';
    await loadAll();
  }
  const { summary: s, auth } = state.data;

  el.innerHTML = `
    ${auth.passwordSet ? '' : `<p class="notice" style="margin-bottom:var(--s-4)">
      <b>No password set.</b> Anyone on your Tailscale network can open this panel.
      Set one with <code>docker compose exec contrast-funnel node src/cli.js set-password</code>.</p>`}
    <div class="tabs" role="tablist" aria-label="Sections">
      ${TABS.map(([id, label]) => `<button class="tab" role="tab" id="tab-${id}"
        aria-selected="${state.tab === id}">${label}</button>`).join('')}
    </div>
    <div id="panel" role="tabpanel" tabindex="-1">
      <h1>${esc(TABS.find(([id]) => id === state.tab)[1])}</h1>
      ${{
        overview: viewOverview, audience: viewAudience, scans: viewScans,
        incidents: viewIncidents, database: viewDatabase,
      }[state.tab](s)}</div>`;

  TABS.forEach(([id]) => $(`#tab-${id}`).addEventListener('click', () => { state.tab = id; render(); }));
  wire();
}

// ---------------------------------------------------------------- sections

function viewOverview(s) {
  // Every stage counts distinct people, so the funnel can only narrow. Totals
  // (196 scans from 40 visitors) belong in the stat tiles, not here.
  const stages = [
    { label: 'Visited the site', n: s.journey.visitors },
    { label: 'Started a scan', n: s.journey.scanned },
    { label: 'Got a clean result', n: s.journey.completed },
    { label: 'Clicked to donate', n: s.journey.clicked },
  ];
  return `
    <div class="stats">
      <div class="stat"><b class="num">${num(s.totalScans)}</b><span>total scans</span></div>
      <div class="stat"><b class="num">${pct(s.completionRate)}</b><span>completed cleanly</span></div>
      <div class="stat"><b class="num">${num(s.retention.visitors)}</b><span>unique visitors</span></div>
      <div class="stat accent"><b class="num">${num(s.totalFindings)}</b><span>findings surfaced</span></div>
      <div class="stat"><b class="num">${secs(s.duration.p50)}</b><span>median scan</span></div>
    </div>

    <div class="grid-2">
      <section class="card">
        <h2>Scans per day</h2>
        <p class="dim cap">Last 30 days. The peak is labelled; hover any day for its count.</p>
        ${areaChart(s.scansByDay, { label: 'scans' })}
      </section>
      <section class="card">
        <h2>Where people drop off</h2>
        <p class="dim cap">Distinct people at each stage — not scans, so the funnel can only narrow.
          ${num(s.totalScans)} scans came from ${num(s.journey.scanned)} of them.</p>
        ${funnelChart(stages)}
      </section>
    </div>

    <div class="grid-2">
      <section class="card">
        <h2>How scans ended</h2>
        <p class="dim cap">Derived from each run's own notes — blocked means the crawler stopped itself.</p>
        ${bars(s.outcomes.map((o) => ({
          label: o.outcome, n: o.n, tone: OUTCOME_TONE[o.outcome] ?? 'minor', badge: o.outcome === 'completed' ? 'ok' : OUTCOME_TONE[o.outcome],
        })))}
      </section>
      <section class="card">
        <h2>Funding</h2>
        <p class="dim cap">$${num(s.funding.raised)} of $${num(s.funding.target)}${s.funding.next ? ` · next at $${s.funding.next.at}: ${esc(s.funding.next.title)}` : ' · every goal met'}</p>
        <span class="bar" data-tip="${pct(s.funding.percent / 100)} of the whole ladder"><i style="width:${s.funding.percent}%"></i></span>
        <div style="margin-top:var(--s-4)">
          <h3 style="font-size:var(--fs-sm);margin-bottom:var(--s-2)">Donation clicks by placement</h3>
          ${bars(s.clicks.map((c) => ({ label: c.button, n: c.n })))}
        </div>
      </section>
    </div>`;
}

function viewAudience(s) {
  return `
    <div class="stats">
      <div class="stat"><b class="num">${num(s.retention.visitors)}</b><span>unique visitors</span></div>
      <div class="stat accent"><b class="num">${pct(s.retention.rate)}</b><span>came back</span></div>
      <div class="stat"><b class="num">${s.retention.avgScansPerVisitor.toFixed(1)}</b><span>scans / visitor</span></div>
      <div class="stat"><b class="num">${num(s.retention.returning)}</b><span>returning</span></div>
    </div>
    <section class="card">
      <h2>When people scan</h2>
      <p class="dim cap">Hour of day, UTC. Tells you when a deploy or a restart is least disruptive.</p>
      ${hourChart(s.byHour)}
    </section>
    <div class="grid-2">
      <section class="card"><h2>Device</h2>
        <p class="dim cap">From the User-Agent at scan time. No raw IP is ever stored.</p>
        ${bars(s.devices.map((d) => ({ label: d.device || 'unknown', n: d.n })))}</section>
      <section class="card"><h2>Region</h2>
        <p class="dim cap">Offline GeoIP lookup — the address never leaves this server.</p>
        ${bars(s.regions.map((r) => ({ label: r.country, n: r.n })))}</section>
    </div>`;
}

function viewScans(s) {
  const runs = state.data.runs;
  return `
    <div class="stats">
      <div class="stat"><b class="num">${secs(s.duration.p50)}</b><span>median duration</span></div>
      <div class="stat"><b class="num">${secs(s.duration.p95)}</b><span>95th percentile</span></div>
      <div class="stat"><b class="num">${num(s.totalFindings)}</b><span>findings total</span></div>
      <div class="stat"><b class="num">${s.totalScans ? (s.totalFindings / s.totalScans).toFixed(0) : 0}</b><span>avg per scan</span></div>
    </div>
    <div class="grid-2">
      <section class="card">
        <h2>What the scanner finds</h2>
        <p class="dim cap">Across every public scan. Severity is named, never colour alone.</p>
        ${bars(SEV_ORDER.map((sev) => ({
          label: sev, badge: sev, tone: sev, n: s.bySeverity.find((b) => b.severity === sev)?.n ?? 0,
        })).filter((r) => r.n))}
      </section>
      <section class="card">
        <h2>Most scanned sites</h2>
        <p class="dim cap">Top ${s.topDomains.length} by number of scans.</p>
        ${bars(s.topDomains.map((d) => ({ label: d.host, n: d.n })))}
      </section>
    </div>
    <section class="card">
      <div class="card-head">
        <h2>Recent scans</h2>
        <span class="row" style="gap:var(--s-2)">
          <input type="search" id="run-filter" class="mono" placeholder="filter by address" style="max-width:220px">
          <button class="btn" id="cleanup">Run 15-day cleanup</button>
        </span>
      </div>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table class="data" id="runs-table">
        <thead><tr><th>Address</th><th>Started</th><th>Findings</th><th>Device</th><th>Region</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${runs.map((r) => `<tr data-url="${esc(r.seedUrl)}">
          <td><button class="link-btn mono" data-detail="${esc(r.id)}" title="${esc(r.seedUrl)}">${esc(r.seedUrl.length > 52 ? r.seedUrl.slice(0, 52) + '…' : r.seedUrl)}</button>
            ${r.notes ? `<br><span class="badge moderate" title="${esc(r.notes)}">${esc(r.notes.slice(0, 40))}</span>` : ''}</td>
          <td class="dim">${when(r.startedAt)}</td>
          <td class="mono">${num(r.findingCount)}</td>
          <td class="dim">${esc(r.device ?? '—')}</td>
          <td class="dim">${esc(r.country ?? '—')}</td>
          <td><span class="row" style="gap:var(--s-1);flex-wrap:nowrap">
            <button class="btn sm" data-flag="${esc(r.id)}">Flag</button>
            <button class="btn sm danger" data-delete="${esc(r.id)}">Delete</button>
          </span></td>
        </tr>`).join('') || '<tr><td colspan="6" class="dim">No scans yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

function viewIncidents(s) {
  const { incidents, rules } = state.data;
  return `
    <section class="card">
      <div class="card-head">
        <h2>Incidents needing a rule <span class="badge ${incidents.length ? 'moderate' : 'ok'}">${incidents.length}</span></h2>
      </div>
      <p class="dim cap">Every scan failure the scanner noticed itself, plus anything you flagged by hand.
        Turning one into a rule teaches future scans to stop wasting a browser on it.</p>
      ${incidents.length ? incidents.map((i) => `<div class="list-row">
        <span style="flex:1 1 320px">
          <span class="badge">${esc(i.kind)}</span>
          <span class="mono dim">${esc(i.url ?? i.runId ?? '')}</span>
          <br><span class="dim" style="font-size:var(--fs-sm)">${esc(i.detail ?? '')} · ${when(i.ts)}</span>
        </span>
        <span class="row" style="gap:var(--s-2)">
          <button class="btn sm" data-dismiss="${esc(i.id)}">Dismiss</button>
          <button class="btn sm primary" data-rule="${esc(i.id)}" data-url="${esc(i.url ?? '')}">Turn into rule</button>
        </span></div>`).join('') : '<p class="dim" style="margin:0">Nothing flagged. The scanner is behaving.</p>'}
    </section>

    <section class="card">
      <h2>Active rules <span class="badge">${rules.length}</span></h2>
      <p class="dim cap">Applied on every scan. A page matching one is recorded as blocked instead of scanned.</p>
      ${rules.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table class="data">
        <thead><tr><th>Pattern</th><th>Type</th><th>Action</th><th>Created</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${rules.map((r) => `<tr>
          <td class="mono">${esc(r.pattern)}</td>
          <td><span class="badge">${esc(r.patternType)}</span></td>
          <td class="dim">${esc(r.action)}</td>
          <td class="dim">${when(r.createdAt)}</td>
          <td><button class="btn sm danger" data-rule-delete="${esc(r.id)}">Delete</button></td>
        </tr>`).join('')}</tbody></table></div>`
        : '<p class="dim" style="margin:0">No rules yet.</p>'}
    </section>`;
}

function viewDatabase(s) {
  const { tables } = state.data;
  const t = tables.tables.find((x) => x.name === state.table) ?? tables.tables[0];
  return `
    <div class="stats">
      <div class="stat"><b class="num">${bytes(tables.storage)}</b><span>on disk (runs/)</span></div>
      <div class="stat"><b class="num">${num(tables.tables.reduce((n, x) => n + x.rows, 0))}</b><span>rows total</span></div>
      <div class="stat"><b class="num">${num(s.rules)}</b><span>active rules</span></div>
      <div class="stat"><b class="num">${num(s.openIncidents)}</b><span>open incidents</span></div>
    </div>
    <section class="card">
      <div class="card-head">
        <h2>Tables</h2>
        <span class="row" style="gap:var(--s-2)">
          <a class="btn sm" href="/api/table/${esc(state.table)}?format=csv" download>Export ${esc(state.table)}.csv</a>
          <button class="btn sm danger" id="cleanup">Run 15-day cleanup</button>
        </span>
      </div>
      <div class="chips">${tables.tables.map((x) => `<button class="chip${x.name === state.table ? ' on' : ''}"
        data-table="${esc(x.name)}">${esc(x.name)} <span class="mono dim">${num(x.rows)}</span></button>`).join('')}</div>
      <div id="rows" style="margin-top:var(--s-3)"><div class="skeleton" style="height:180px"></div></div>
    </section>`;
}

async function paintRows() {
  const host = $('#rows');
  if (!host) return;
  const d = await api(`/api/table/${encodeURIComponent(state.table)}?limit=25&offset=${state.offset}`);
  const cols = d.rows.length ? Object.keys(d.rows[0]) : [];
  host.innerHTML = `
    <div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table"><table class="data">
      <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${d.rows.map((r) => `<tr>${cols.map((c) => `<td class="mono">${esc(r[c] ?? '')}</td>`).join('')}</tr>`).join('')
        || `<tr><td class="dim">empty table</td></tr>`}</tbody>
    </table></div>
    <div class="row" style="justify-content:space-between;margin-top:var(--s-3)">
      <span class="dim" style="font-size:var(--fs-sm)">${d.total ? `${d.offset + 1}–${Math.min(d.offset + d.limit, d.total)} of ${num(d.total)}` : 'no rows'}</span>
      <span class="row" style="gap:var(--s-2)">
        <button class="btn sm" id="prev" ${d.offset ? '' : 'disabled'}>Previous</button>
        <button class="btn sm" id="next" ${d.offset + d.limit < d.total ? '' : 'disabled'}>Next</button>
      </span>
    </div>`;
  $('#prev')?.addEventListener('click', () => { state.offset = Math.max(0, state.offset - 25); paintRows(); });
  $('#next')?.addEventListener('click', () => { state.offset += 25; paintRows(); });
}

// ------------------------------------------------------------------ wiring

const refresh = async () => { state.data = null; await render(); };

function wire() {
  if (state.tab === 'database') paintRows();

  $$('[data-table]').forEach((b) => b.addEventListener('click', () => {
    state.table = b.dataset.table;
    state.offset = 0;
    render();
  }));

  $('#cleanup')?.addEventListener('click', async () => {
    if (!(await ask({
      title: 'Delete scans older than 15 days?',
      body: 'Removes their database rows and their files on disk. This is the same job that runs automatically.',
      confirmText: 'Run cleanup', danger: true,
    }))) return;
    try {
      const r = await post('/api/cleanup');
      toast(`Deleted ${r.deleted} run${r.deleted === 1 ? '' : 's'}.`);
      refresh();
    } catch (err) { toast(err.message); }
  });

  $('#run-filter')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#runs-table tbody tr').forEach((tr) => {
      tr.hidden = !!q && !(tr.dataset.url ?? '').toLowerCase().includes(q);
    });
  });

  $$('[data-detail]').forEach((b) => b.addEventListener('click', () => showRun(b.dataset.detail)));

  $$('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await ask({
      title: 'Delete this scan?', body: 'Its database rows and files go too. This cannot be undone.',
      confirmText: 'Delete', danger: true,
    }))) return;
    try { await post(`/api/runs/${encodeURIComponent(b.dataset.delete)}/delete`); toast('Deleted'); refresh(); }
    catch (err) { toast(err.message); }
  }));

  $$('[data-flag]').forEach((b) => b.addEventListener('click', async () => {
    const note = await ask({ title: 'Flag this scan', label: 'What looks wrong about it?', confirmText: 'Flag' });
    if (note == null) return;
    try { await post(`/api/runs/${encodeURIComponent(b.dataset.flag)}/flag`, { note }); toast('Flagged'); refresh(); }
    catch (err) { toast(err.message); }
  }));

  $$('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
    try { await post(`/api/incidents/${encodeURIComponent(b.dataset.dismiss)}/dismiss`); refresh(); }
    catch (err) { toast(err.message); }
  }));

  $$('[data-rule]').forEach((b) => b.addEventListener('click', async () => {
    let domain = '';
    try { domain = new URL(b.dataset.url).hostname; } catch {}
    const pattern = await ask({
      title: 'Create a rule',
      body: 'A domain (like <code>example.com</code>). Future scans that reach it are recorded as blocked instead of scanned.',
      label: 'Domain', value: domain, confirmText: 'Create rule',
    });
    if (!pattern) return;
    try {
      await post(`/api/incidents/${encodeURIComponent(b.dataset.rule)}/rule`,
        { patternType: 'domain', pattern, action: 'treat_as_blocked' });
      toast('Rule created');
      refresh();
    } catch (err) { toast(err.message); }
  }));

  $$('[data-rule-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await ask({
      title: 'Delete this rule?', body: 'Scans will stop treating matching pages as blocked.',
      confirmText: 'Delete', danger: true,
    }))) return;
    try { await post(`/api/rules/${encodeURIComponent(b.dataset.ruleDelete)}/delete`); toast('Rule deleted'); refresh(); }
    catch (err) { toast(err.message); }
  }));
}

async function showRun(runId) {
  let d;
  try { d = await api(`/api/runs/${encodeURIComponent(runId)}`); }
  catch (err) { return toast(err.message); }
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal card" role="dialog" aria-modal="true" aria-labelledby="rd-t" style="width:min(720px,94vw)">
    <h2 id="rd-t">Scan detail</h2>
    <p class="mono dim" style="word-break:break-all">${esc(d.run.seedUrl)}</p>
    <div class="stats" style="margin:var(--s-3) 0">
      <div class="stat"><b class="num">${num(d.pages.length)}</b><span>pages</span></div>
      <div class="stat"><b class="num">${num(d.bySeverity.reduce((n, b) => n + b.n, 0))}</b><span>findings</span></div>
      <div class="stat"><b class="num">${d.run.finishedAt ? secs((Date.parse(d.run.finishedAt) - Date.parse(d.run.startedAt)) / 1000) : '—'}</b><span>duration</span></div>
    </div>
    ${d.run.notes ? `<p class="notice">${esc(d.run.notes)}</p>` : ''}
    ${d.bySeverity.length ? `<h3 style="font-size:var(--fs-sm);margin:var(--s-3) 0 var(--s-2)">By severity</h3>
      ${bars(SEV_ORDER.map((sev) => ({ label: sev, badge: sev, tone: sev, n: d.bySeverity.find((b) => b.severity === sev)?.n ?? 0 })).filter((r) => r.n))}` : ''}
    ${d.topRules.length ? `<h3 style="font-size:var(--fs-sm);margin:var(--s-4) 0 var(--s-2)">Most common rules</h3>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table" style="max-height:200px"><table class="data"><tbody>
      ${d.topRules.map((r) => `<tr><td class="mono">${esc(r.ruleId)}</td><td class="mono">${r.n}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <h3 style="font-size:var(--fs-sm);margin:var(--s-4) 0 var(--s-2)">Pages</h3>
    <div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable table" style="max-height:220px"><table class="data">
      <thead><tr><th>URL</th><th>Status</th></tr></thead>
      <tbody>${d.pages.map((p) => `<tr><td class="mono">${esc(p.finalUrl ?? p.url)}</td>
        <td>${p.error ? `<span class="badge critical">${esc(p.error.slice(0, 30))}</span>` : `<span class="badge ok">${p.status ?? '—'}</span>`}</td></tr>`).join('')
        || '<tr><td class="dim">no pages recorded</td></tr>'}</tbody>
    </table></div>
    <div class="row" style="margin-top:var(--s-4)"><button class="btn primary" id="rd-close">Close</button></div>
  </div>`;
  document.body.append(back);
  const close = () => back.remove();
  $('#rd-close', back).addEventListener('click', close);
  back.addEventListener('click', (e) => e.target === back && close());
  back.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  $('#rd-close', back).focus();
}

mountTips();
$('#reload')?.addEventListener('click', () => refresh().catch((err) => toast(err.message)));
render().catch((err) => {
  $('#content').innerHTML = `<p class="notice" role="alert">Could not load: ${esc(err.message)}</p>`;
});

// Contrast — funnel monitoring. Standalone page, same design system as the
// admin dashboard (tokens.css/app.css served straight from src/ui/public/ by
// src/funnel/server.js) but its own small script — no shared state, no
// sidebar/tabs, just this one view.

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

/** Same dialog as the dashboard's — see src/ui/public/app.js for why it
 *  exists instead of native prompt()/confirm(). Duplicated, not shared,
 *  to keep this a standalone page. */
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

const pct = (n) => `${Math.round((n ?? 0) * 100)}%`;

function barRows(rows, key = 'n') {
  const max = Math.max(1, ...rows.map((r) => r[key]));
  // .bar-row's default label column (74px) fits four-letter severity words,
  // not device strings or button ids — widen it here.
  return rows.map((r) => `<div class="bar-row" style="grid-template-columns:120px 1fr 40px">
    <span class="badge" style="white-space:nowrap">${esc(r.label)}</span>
    <span class="bar"><i style="width:${(r[key] / max) * 100}%"></i></span>
    <span class="n">${r[key]}</span>
  </div>`).join('') || '<p class="dim">none yet</p>';
}

async function render() {
  const el = $('#content');
  el.innerHTML = '<h1>Funnel</h1><div class="skeleton" style="height:220px;margin-top:16px"></div>';
  const [s, runsData, incidentsData] = await Promise.all([
    api('/api/summary'), api('/api/runs?limit=30'), api('/api/incidents'),
  ]);

  el.innerHTML = `<h1>Funnel</h1>
    <p class="dim" style="font-size:var(--fs-sm)">Usage of the free public scanner —
      database records, analytics and self-flagged incidents, all separate from
      the scanner itself and from your own audits.</p>

    <div class="stats">
      <div class="stat"><b class="num">${s.totalScans}</b><span>total scans</span></div>
      <div class="stat"><b class="num">${pct(s.completionRate)}</b><span>completion rate</span></div>
      <div class="stat"><b class="num">${s.retention.visitors}</b><span>unique visitors</span></div>
      <div class="stat accent"><b class="num">${pct(s.retention.rate)}</b><span>returning</span></div>
      <div class="stat"><b class="num">${s.retention.avgScansPerVisitor.toFixed(1)}</b><span>avg scans / visitor</span></div>
    </div>

    <h2>Funding</h2>
    <div class="card" style="margin:8px 0 24px">
      <p style="margin:0 0 8px">$${s.funding.raised} of $${s.funding.target} raised${s.funding.next ? ` · next at $${s.funding.next.at}: ${esc(s.funding.next.title)}` : ' · every goal met'}</p>
      <div class="bars"><div class="bar-row"><span class="badge">${pct(s.funding.percent / 100)}</span><span class="bar"><i style="width:${s.funding.percent}%"></i></span><span class="n"></span></div></div>
    </div>

    <div class="row" style="align-items:flex-start">
      <div class="card" style="flex:1 1 260px">
        <h2 style="margin-top:0">Device</h2>
        <div class="bars">${barRows(s.devices.map((d) => ({ label: d.device || 'unknown', n: d.n })))}</div>
      </div>
      <div class="card" style="flex:1 1 260px">
        <h2 style="margin-top:0">Region</h2>
        <div class="bars">${barRows(s.regions.map((r) => ({ label: r.country, n: r.n })))}</div>
      </div>
      <div class="card" style="flex:1 1 260px">
        <h2 style="margin-top:0">Donation clicks</h2>
        <div class="bars">${barRows(s.clicks.map((c) => ({ label: c.button, n: c.n })))}</div>
      </div>
    </div>

    <h2>Incidents needing a rule <span class="badge ${incidentsData.incidents.length ? 'moderate' : 'ok'}">${incidentsData.incidents.length}</span></h2>
    <div class="card" id="incidents" style="margin:8px 0 24px">
      ${incidentsData.incidents.length ? incidentsData.incidents.map((i) => `
        <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:var(--s-2) 0">
          <span style="flex:1 1 300px"><span class="badge">${esc(i.kind)}</span> <span class="mono dim">${esc(i.url ?? i.runId ?? '')}</span><br><span class="dim" style="font-size:var(--fs-sm)">${esc(i.detail ?? '')}</span></span>
          <span class="row" style="gap:var(--s-2)">
            <button class="btn" data-dismiss="${i.id}">Dismiss</button>
            <button class="btn primary" data-rule="${i.id}" data-url="${esc(i.url ?? '')}">Turn into rule</button>
          </span>
        </div>`).join('') : '<p class="dim" style="margin:0">Nothing flagged.</p>'}
    </div>

    <h2>Recent scans <button class="btn" id="cleanup" style="margin-left:12px">Run 15-day cleanup now</button></h2>
    <div class="card" id="runs">
      ${runsData.runs.map((r) => `
        <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:var(--s-2) 0">
          <span style="flex:1 1 320px" class="mono" title="${esc(r.seedUrl)}">${esc(r.seedUrl.length > 60 ? r.seedUrl.slice(0, 60) + '…' : r.seedUrl)}</span>
          <span class="dim" style="font-size:var(--fs-sm)">${esc((r.startedAt || '').slice(0, 16).replace('T', ' '))}</span>
          <span class="badge">${r.findingCount} findings</span>
          <span class="dim" style="font-size:var(--fs-sm)">${esc(r.device ?? '')} ${esc(r.country ?? '')}</span>
          <span class="row" style="gap:var(--s-2)">
            <button class="btn" data-flag="${r.id}">Flag</button>
            <button class="btn danger" data-delete="${r.id}">Delete</button>
          </span>
        </div>`).join('') || '<p class="dim" style="margin:0">No scans yet.</p>'}
    </div>`;

  $('#cleanup').addEventListener('click', async () => {
    try {
      const r = await post('/api/cleanup');
      toast(`Deleted ${r.deleted} run${r.deleted === 1 ? '' : 's'} older than 15 days.`);
      render();
    } catch (err) { toast(err.message); }
  });

  $$('#runs [data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.delete;
    if (!(await ask({ title: 'Delete this scan?', body: 'This removes its database rows and files. It cannot be undone.', confirmText: 'Delete', danger: true }))) return;
    try { await post(`/api/runs/${encodeURIComponent(id)}/delete`); toast('Deleted'); render(); }
    catch (err) { toast(err.message); }
  }));

  $$('#runs [data-flag]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.flag;
    const note = await ask({ title: 'Flag this scan', label: 'What looks wrong?', confirmText: 'Flag' });
    if (note == null) return;
    try { await post(`/api/runs/${encodeURIComponent(id)}/flag`, { note }); toast('Flagged'); render(); }
    catch (err) { toast(err.message); }
  }));

  $$('#incidents [data-dismiss]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await post(`/api/incidents/${encodeURIComponent(btn.dataset.dismiss)}/dismiss`); render(); }
    catch (err) { toast(err.message); }
  }));

  $$('#incidents [data-rule]').forEach((btn) => btn.addEventListener('click', async () => {
    let domain = '';
    try { domain = new URL(btn.dataset.url).hostname; } catch {}
    const pattern = await ask({ title: 'Rule pattern', body: 'A domain (e.g. example.com) — future scans that hit it are treated as blocked.', label: 'Domain', value: domain, confirmText: 'Create rule' });
    if (!pattern) return;
    try {
      await post(`/api/incidents/${encodeURIComponent(btn.dataset.rule)}/rule`, { patternType: 'domain', pattern, action: 'treat_as_blocked' });
      toast('Rule created');
      render();
    } catch (err) { toast(err.message); }
  }));
}

render().catch((err) => toast(err.message));

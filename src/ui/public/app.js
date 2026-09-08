// Contrast — dashboard. Vanilla ES modules, no framework, no build step.
// Structure follows the mental model in DESIGN.md: client -> run (a version)
// -> finding, with deltas between adjacent runs always in view.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
/** Mutations carry the header the server's CSRF fence requires. */
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
    setTimeout(() => (el.hidden = true), 250);
  }, 4200);
};

function countTo(el, value, ms = 700) {
  if (REDUCED) return (el.textContent = value);
  const from = Number(el.textContent) || 0;
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    el.textContent = Math.round(from + (value - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const state = {
  runs: [], clients: [], groups: [], timelines: {},
  client: null, target: null, run: null, findings: [], summary: null,
  view: 'new', job: null, compare: [], browser: null,
};

// ------------------------------------------------------------- theme

const applyTheme = (t) => {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('contrast-theme', t);
};
applyTheme(localStorage.getItem('contrast-theme') ?? 'system');
$('#theme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(localStorage.getItem('contrast-theme') ?? 'system') + 1) % 3];
  applyTheme(next);
  toast(`Theme: ${next}`);
});

// ------------------------------------------------------- sidebar tree

// Run ids are UTC. Slicing the clock time out of the id showed everyone UTC and
// called it local — hours off for most of the world. Always format the real
// timestamp in the viewer's own zone.
const shortId = (id) => id.replace(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d).*$/, '$3/$2 $4:$5');

const runTime = (run) => {
  const iso = run?.startedAt;
  if (!iso) return shortId(run?.id ?? '');
  return new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

/** "4 min ago" reads faster than a clock time when scanning a history list. */
function ago(iso) {
  if (!iso) return '';
  const secs = (Date.now() - new Date(iso)) / 1000;
  const steps = [[60, 'sec'], [60, 'min'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month']];
  let n = secs;
  let unit = 'sec';
  for (const [size, name] of steps) {
    if (n < size) { unit = name; break; }
    n /= size;
    unit = name;
  }
  const v = Math.max(1, Math.floor(n));
  return `${v} ${unit}${v === 1 ? '' : 's'} ago`;
}

const duration = (a, b) => {
  if (!a || !b) return null;
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

function deltaChip(d) {
  if (!d) return '<span class="delta flat">first run</span>';
  const net = d.new - d.fixed;
  const cls = net < 0 ? 'down' : net > 0 ? 'up' : 'flat';
  const sign = net > 0 ? '+' : '';
  return `<span class="delta ${cls}">${sign}${net}</span>`;
}

/**
 * group → client → run. Groups are how an auditor runs "the whole Acme estate"
 * in one go; a client's runs are its versions.
 */
function renderTree() {
  const byClient = new Map();
  for (const r of state.runs) {
    if (!byClient.has(r.clientId)) byClient.set(r.clientId, []);
    byClient.get(r.clientId).push(r);
  }
  if ($('#run-total')) $('#run-total').textContent = `${state.runs.length} runs`;

  const groups = state.groups.length
    ? state.groups
    : [{ id: '__all', label: 'Clients', clients: [...new Set([...state.clients.map((c) => c.id), ...byClient.keys()])] }];

  $('#tree').setAttribute('aria-busy', 'false');
  $('#tree').innerHTML = groups
    .map((g) => {
      const total = g.clients.reduce((n, c) => n + (byClient.get(c)?.length ?? 0), 0);
      const openGroup = g.clients.includes(state.client) || groups.length === 1;
      return `<section class="grp ${openGroup ? 'open' : ''}" data-group="${esc(g.id)}">
      <div class="grp-row">
        ${/* the count is a number, not a sentence — the name needs the room */ ''}
        <button class="client-row grp-toggle" aria-expanded="${openGroup}"
                title="${esc(g.label)} — ${g.clients.length} site(s), ${total} run(s)">
          <span class="twist" aria-hidden="true">›</span>
          ${g.pinned ? '<span class="pin" aria-label="pinned" title="Pinned">&#9679;</span>' : ''}
          <span class="name">${esc(g.label)}</span>
          <span class="count">${g.clients.length}</span>
        </button>
        ${g.id !== '__ungrouped' && g.id !== '__all' ? `<button class="btn sm grp-run" data-target="${esc(g.id)}" title="Audit every site in ${esc(g.label)}">Run group</button>` : ''}
      </div>
      <div class="grp-body">
        ${g.clients.map((clientId) => clientBlock(clientId, byClient.get(clientId) ?? [])).join('')}
      </div>
    </section>`;
    })
    .join('');

  $$('.grp-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.closest('.grp');
      btn.setAttribute('aria-expanded', String(g.classList.toggle('open')));
    });
    const id = btn.closest('.grp').dataset.group;
    const g = groups.find((x) => x.id === id);
    if (g && !id.startsWith('__')) onContext(btn, () => groupMenu(g));
  });
  $$('.grp-run').forEach((btn) =>
    btn.addEventListener('click', () => {
      startRun(btn.dataset.target);
    })
  );
  $$('.client-toggle').forEach((btn) => {
    const clientId = btn.closest('.client-group').dataset.client;
    btn.addEventListener('click', () => {
      const group = btn.closest('.client-group');
      const open = group.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      selectClient(clientId);
    });
    onContext(btn, () => clientMenu(clientId, byClient.get(clientId)?.length ?? 0));
  });
  $$('.run-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) return toggleCompare(btn.dataset.run);
      openRun(btn.dataset.run);
    });
    const run = state.runs.find((r) => r.id === btn.dataset.run);
    if (run) onContext(btn, () => runMenu(run));
  });
}

const clientBlock = (clientId, runs) => {
  const meta = state.clients.find((c) => c.id === clientId);
  const open = state.client === clientId;
  return `<div class="client-group ${open ? 'open' : ''}" data-client="${esc(clientId)}">
    <button class="client-row client-toggle" aria-expanded="${open}">
      <span class="twist" aria-hidden="true">›</span>
      ${meta?.pinned ? '<span class="pin" aria-label="pinned" title="Pinned">&#9679;</span>' : ''}
      <span class="name">${esc(meta?.label ?? clientId)}</span>
      ${meta?.requiresLogin === true ? '<span class="lock" title="Always signs in first" aria-label="signs in first">&#128274;</span>' : ''}
      <span class="count">${runs.length}</span>
    </button>
    <ul class="run-list">
      ${runs.map((r, i) => runItem(r, runs[i + 1])).join('') || '<li class="dim" style="padding:8px 12px;font-size:var(--fs-sm)">no runs yet</li>'}
    </ul>
  </div>`;
};

const runItem = (r, prev) => `<li>
  <button class="run-item" data-run="${esc(r.id)}" aria-current="${state.run?.id === r.id}"
          title="${esc(fullTime(r.startedAt))} — ${esc(r.id)}${prev ? ' · shift-click to compare' : ''}">
    <span class="when">${r.pinned ? '<span class="pin" aria-label="pinned">&#9679;</span> ' : ''}${esc(runTime(r))}</span>
    ${r.finishedAt ? '' : '<span class="badge serious">partial</span>'}
    <span class="sub">
      <span class="mono">${r.total}</span> findings
      <span class="dim">· ${esc(ago(r.startedAt))}</span>
      ${r.ai ? `<span class="badge ai">${r.ai} AI</span>` : ''}
      ${state.compare.includes(r.id) ? '<span class="selected-mark">selected</span>' : ''}
    </span>
  </button>
</li>`;

function selectClient(clientId) {
  state.client = clientId;
  $('#crumb-client').textContent = clientId;
  $('#crumb-client').classList.remove('dim');
  if (state.view === 'history') render();
}

// ------------------------------------------------------------- views

// The tab strip belongs to an open audit. "new" is a separate mode with no tab.
const TABS = ['overview', 'findings', 'history', 'compare', 'settings'];

function setView(v) {
  state.view = v;
  const composing = v === 'new';
  for (const t of TABS) $(`#tab-${t}`).setAttribute('aria-selected', String(t === v));
  $('#tabs').hidden = composing;
  // A tabpanel with no tablist is a lie; in composer mode it is just a region.
  const content = $('#content');
  content.setAttribute('role', composing ? 'region' : 'tabpanel');
  if (composing) content.setAttribute('aria-label', 'New audit');
  else content.removeAttribute('aria-label');
  render();
}
TABS.forEach((t) => $(`#tab-${t}`).addEventListener('click', () => setView(t)));

// Views may await. If the user switches tabs mid-fetch, the late continuation
// must not write into a surface that has already been replaced — so each render
// gets a token and async views check `alive()` before touching the DOM.
let renderSeq = 0;

function render() {
  const el = $('#content');
  el.classList.remove('content');
  void el.offsetWidth; // restart the enter animation
  el.classList.add('content');
  const mine = ++renderSeq;
  const alive = () => mine === renderSeq;
  const view = { new: viewNew, overview: viewOverview, findings: viewFindings, history: viewHistory, compare: viewCompare, settings: viewSettings }[state.view];
  Promise.resolve(view(el, alive)).catch((err) => alive() && toast(err.message));
}

// ------------------------------------------------- ask / confirm modal

/**
 * One small dialog for renaming and for confirming a delete. Native prompt()
 * blocks the event loop and cannot be styled; this returns a promise, traps
 * focus, closes on Escape, and puts focus back where it came from.
 */
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
    const done = (val) => {
      back.remove();
      from?.focus?.();
      resolve(val);
    };
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

// ------------------------------------------------------ context menu

let menuEl = null;

function closeMenu() {
  menuEl?.remove();
  menuEl = null;
}
document.addEventListener('click', (e) => menuEl && !menuEl.contains(e.target) && closeMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);

/**
 * @param {{x:number,y:number}} at
 * @param {{label:string, run?:Function, danger?:boolean, sep?:boolean, checked?:boolean}[]} items
 */
function openMenu(at, items) {
  closeMenu();
  const from = document.activeElement;
  menuEl = document.createElement('div');
  menuEl.className = 'ctx';
  menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = items
    .map((it, i) =>
      it.sep
        ? '<hr aria-hidden="true">'
        : `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">
             <span class="tick" aria-hidden="true">${it.checked ? '✓' : ''}</span>${esc(it.label)}
           </button>`
    )
    .join('');
  document.body.append(menuEl);

  // Keep it on screen — a menu opened near the bottom right must not be clipped.
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(at.x, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(at.y, innerHeight - r.height - 8)}px`;

  const buttons = $$('button', menuEl);
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      const item = items[Number(b.dataset.i)];
      closeMenu();
      from?.focus?.();
      item.run?.();
    })
  );
  menuEl.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    if (e.key === 'Home') { e.preventDefault(); buttons[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); buttons.at(-1).focus(); }
  });
  buttons[0]?.focus();
}

/** Right-click, long-press, the Menu key and Shift+F10 all raise `contextmenu`. */
function onContext(el, build) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    // Keyboard invocation reports 0,0 — anchor to the element instead.
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 16, y: r.bottom };
    openMenu(at, build());
  });
}

const projectItems = (clientId, current) => [
  { label: 'No project', checked: !current, run: () => mutate(`clients/${clientId}`, { action: 'move', group: '' }) },
  ...state.groups
    .filter((g) => !g.id.startsWith('__'))
    .map((g) => ({
      label: g.label,
      checked: g.id === current,
      run: () => mutate(`clients/${clientId}`, { action: 'move', group: g.id }),
    })),
];

async function mutate(path, body, { after = 'refresh' } = {}) {
  try {
    await post(`/api/${path}`, body);
    if (after === 'refresh') await refreshClients({ rerender: true });
    if (state.view !== 'new') render();
  } catch (err) {
    toast(err.message);
  }
}

function groupMenu(g) {
  return [
    { label: 'Run audit on this project', run: () => startRun(g.id) },
    { sep: true },
    {
      label: 'Rename project…',
      run: async () => {
        const label = await ask({ title: 'Rename project', label: 'Project name', value: g.label, confirmText: 'Rename' });
        if (label) mutate(`groups/${g.id}`, { action: 'rename', label });
      },
    },
    { label: g.pinned ? 'Unpin' : 'Pin to top', checked: g.pinned, run: () => mutate(`groups/${g.id}`, { action: 'pin', pinned: !g.pinned }) },
    { sep: true },
    {
      label: 'Delete project',
      danger: true,
      run: async () => {
        const ok = await ask({
          title: `Delete project “${g.label}”?`,
          body: `Its ${g.clients.length} site(s) and every audit stay — they move to <b>Ungrouped</b>. Only the grouping is removed.`,
          confirmText: 'Delete project', danger: true,
        });
        if (ok) mutate(`groups/${g.id}`, { action: 'delete' });
      },
    },
  ];
}

function clientMenu(clientId, runCount) {
  const c = state.clients.find((x) => x.id === clientId) ?? { id: clientId, label: clientId };
  const currentGroup = state.groups.find((g) => !g.id.startsWith('__') && g.clients.includes(clientId))?.id ?? '';
  return [
    { label: 'Run audit on this site', run: () => startRun(clientId) },
    { sep: true },
    {
      label: 'Rename…',
      run: async () => {
        const label = await ask({ title: 'Rename site', label: 'Display name', value: c.label ?? clientId, confirmText: 'Rename' });
        if (label) mutate(`clients/${clientId}`, { action: 'rename', label });
      },
    },
    { label: c.pinned ? 'Unpin' : 'Pin to top', checked: !!c.pinned, run: () => mutate(`clients/${clientId}`, { action: 'pin', pinned: !c.pinned }) },
    { sep: true },
    ...projectItems(clientId, currentGroup),
    { sep: true },
    {
      label: 'Delete site',
      danger: true,
      run: async () => {
        const ok = await ask({
          title: `Delete “${c.label ?? clientId}”?`,
          body: `This removes the site from config.json and deletes <b>${runCount} audit(s)</b>, their findings and their screenshots. It cannot be undone.`,
          confirmText: 'Delete site and its audits', danger: true,
        });
        if (ok) {
          if (state.client === clientId) { state.client = null; state.run = null; state.findings = []; state.summary = null; }
          mutate(`clients/${clientId}`, { action: 'delete' });
        }
      },
    },
  ];
}

function runMenu(r) {
  return [
    { label: 'Open this audit', run: () => openRun(r.id) },
    { label: 'Open printable report', run: () => window.open(`/report/${encodeURIComponent(r.id)}`, '_blank') },
    { label: 'Compare with previous', run: () => { state.compare = [r.id]; toast('Shift-click another run to compare'); } },
    { sep: true },
    { label: r.pinned ? 'Unpin' : 'Pin to top', checked: !!r.pinned, run: () => mutate(`runs/${r.id}`, { action: 'pin', pinned: !r.pinned }) },
    { sep: true },
    {
      label: 'Delete audit',
      danger: true,
      run: async () => {
        const ok = await ask({
          title: 'Delete this audit?',
          body: `Run <code>${esc(r.id)}</code> and its ${r.total} finding(s) and screenshots are removed. Other audits of this site are untouched.`,
          confirmText: 'Delete audit', danger: true,
        });
        if (ok) {
          if (state.run?.id === r.id) { state.run = null; state.findings = []; state.summary = null; }
          mutate(`runs/${r.id}`, { action: 'delete' });
        }
      },
    },
  ];
}

// --------------------------------------------------- new audit (hero)

/**
 * The "new chat" of this app: one input, paste an address, go. A site is
 * created on first use — nobody should have to hand-edit config.json to start.
 */
function viewNew(el) {
  const projects = state.groups.filter((g) => !g.id.startsWith('__'));
  const recent = [...new Map(state.runs.map((r) => [r.clientId, r])).values()].slice(0, 6);
  el.innerHTML = `
    <div class="hero">
      <h1>What should I audit?</h1>
      <p class="dim">Paste the address of a page to start from. I will crawl it, measure what can be
        measured, and stop to ask if the site wants you to sign in.</p>

      <form class="composer" id="composer">
        ${/* deliberately type=text: type=url would reject "example.com" for having
              no scheme, which is exactly what people paste. We normalise instead. */ ''}
        <input type="text" inputmode="url" id="url" name="url"
               placeholder="example.com/dashboard  —  or a full https:// address"
               autocomplete="url" spellcheck="false" aria-label="Address to audit"
               aria-describedby="url-err">
        <button class="btn primary" type="submit" id="start">Start audit</button>
      </form>
      <p class="composer-err" id="url-err" role="alert" hidden></p>

      <div class="composer-opts">
        <label class="field"><span>Name <span class="dim">(optional)</span></span>
          <input type="text" id="name" placeholder="taken from the address"></label>
        <label class="field"><span>Project</span>
          <select id="project">
            <option value="">No project</option>
            ${projects.map((g) => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('')}
          </select></label>
        <label class="field"><span>How deep</span>
          <select id="scope">
            <option value="scan">Scan — measured findings only</option>
            <option value="assess">Scan + AI review</option>
            <option value="full">Full audit — fixes, verified</option>
          </select></label>
        <label class="field"><span>Pages at most</span>
          <input type="number" id="maxPages" value="25" min="1" max="2000" style="min-width:110px"></label>
      </div>
      <p class="dim" id="client-hint" style="font-size:var(--fs-sm);margin:12px 0 0"></p>

      ${recent.length || projects.length ? `<div class="recent">
        <p class="side-label" style="padding-left:0">Audit again</p>
        <div class="chips">
          ${projects.map((g) => `<button class="chip" data-target="${esc(g.id)}" title="Every site in ${esc(g.label)}">${esc(g.label)} <span class="dim">· ${g.clients.length} sites</span></button>`).join('')}
          ${recent.map((r) => {
            const c = state.clients.find((x) => x.id === r.clientId);
            return `<button class="chip" data-target="${esc(r.clientId)}" title="${esc(c?.seedUrl ?? '')}">${esc(c?.label ?? r.clientId)}</button>`;
          }).join('')}
        </div>
        <p class="dim" style="font-size:var(--fs-sm);margin-top:8px">Uses the depth selected above.</p>
      </div>` : ''}
    </div>`;

  const form = $('#composer');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    startNewAudit();
  });
  $('#scope').addEventListener('change', hint);
  hint();
  $$('.chip').forEach((b) => b.addEventListener('click', () => startRun(b.dataset.target, $('#scope').value)));
  $('#url').focus();
}

/** Start an audit of something that already exists: a site id or a project id. */
async function startRun(target, scope = 'scan') {
  if (!target) return;
  try {
    const job = await post('/api/jobs', { command: 'run', target, scope });
    state.job = { ...job, clientId: target };
    state.target = target;
    setView('overview');
    toast('Audit started');
  } catch (err) {
    toast(err.message);
  }
}

async function startNewAudit(clientId = null) {
  const err = $('#url-err');
  const url = $('#url').value.trim();
  if (!clientId && !url) {
    err.textContent = 'Enter an address first — for example example.com or https://app.example.com/home';
    err.hidden = false;
    return $('#url').focus();
  }
  // Same rule the server applies, so the message arrives before the round trip.
  if (!clientId && !/^([a-z][a-z0-9+.-]*:\/\/)?[^\s/]+\.[^\s/]{2,}/i.test(url) && !/^https?:\/\/localhost(:\d+)?/i.test(url)) {
    err.textContent = `"${url}" does not look like a web address. Try example.com or https://app.example.com/home`;
    err.hidden = false;
    return $('#url').focus();
  }
  err.hidden = true;
  $('#start').disabled = true;
  $('#start').innerHTML = `${CMARK} Starting…`;
  $('#start').querySelector('.cmark')?.classList.add('is-loading');
  try {
    const body = clientId
      ? { clientId, scope: $('#scope').value }
      : {
          url, name: $('#name').value, group: $('#project').value,
          scope: $('#scope').value, maxPages: Number($('#maxPages').value) || 25,
        };
    const job = await post('/api/audits', body);
    state.job = job;
    state.job.clientId = job.clientId;
    state.client = job.clientId;
    state.target = job.clientId;
    await refreshClients();
    // setView renders the overview, which mounts the console itself — calling it
    // again here opened a second event stream and doubled every log line.
    setView('overview');
    toast('Audit started');
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    if ($('#start')) { $('#start').disabled = false; $('#start').textContent = 'Start audit'; }
  }
}

async function refreshClients({ rerender = false } = {}) {
  const cfg = await api('/api/clients');
  state.clients = cfg.clients ?? [];
  state.groups = cfg.groups ?? [];
  state.runs = await api('/api/runs');
  renderTree();
  // A project created while the composer is open must appear in its picker.
  if (rerender && state.view === 'new') render();
}

$('#new-audit').addEventListener('click', () => setView('new'));
$('#new-project').addEventListener('click', async () => {
  const label = await ask({
    title: 'New project',
    body: 'Group the sites belonging to one client, brand or estate, so you can audit them together.',
    label: 'Project name', confirmText: 'Create',
  });
  if (!label) return;
  try {
    const g = await post('/api/groups', { label });
    await refreshClients({ rerender: true });
    toast(`Project "${g.label}" created`);
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------- overview

function viewOverview(el) {
  const c = state.client ?? state.clients[0]?.id ?? '';
  el.innerHTML = `
    <h1>Audit runs</h1>
    <p class="notice"><b>Scope and limits.</b> Automated testing detects roughly 30–40% of WCAG issues.
      Nothing here is a claim of conformance. <b>Assessed</b> findings are model judgments and need
      auditor confirmation; <b>measured</b> findings are tool output.</p>

    ${/* No launcher here. Starting a run belongs to the composer (+ New audit),
          so an open audit page cannot be confused for a place to start one. */ ''}

    <div class="console-wrap" id="console-wrap" hidden>
      <div class="console-head">
        <h3>Job <span class="mono dim" id="job-name"></span></h3>
        <span class="badge" id="job-status">running</span>
        <span class="dim" id="job-stage" style="font-size:var(--fs-sm)"></span>
        <button class="btn sm" id="job-continue" hidden>I have logged in — continue</button>
        <button class="btn sm" id="job-stop">Stop</button>
      </div>
      <pre class="console" id="console" tabindex="0" aria-label="Job output" aria-live="polite"></pre>
    </div>

    ${state.run ? runSummaryHtml() : `<div class="empty-mark">${CMARK}<p>No audit open. Pick one in the sidebar, or start one with <b>+ New audit</b>.</p></div>`}`;

  if (state.job) mountConsole();
  if (state.summary) paintSummary();
}

/** Say what will happen, in plain words, before it happens. */
function hint() {
  const el = $('#client-hint');
  if (!el) return;
  const scope = $('#scope')?.value ?? 'scan';
  const depth = {
    scan: 'axe, the accessibility tree and a keyboard trace — all measured, no AI.',
    assess: 'everything in Scan, plus Gemini judging alt text, link text, headings, forms and reading order.',
    full: 'everything in Scan + AI review, then generated fixes that are re-tested in a fresh browser before being called verified.',
  }[scope];
  el.textContent = depth;
}

const runSummaryHtml = () => `
  <h2 style="margin-top:24px">Run <span class="mono dim">${esc(state.run.id)}</span></h2>
  <div class="stats">
    <div class="stat"><b class="num" data-to="0">0</b><span>findings</span></div>
    <div class="stat"><b class="num" data-to="0">0</b><span>measured</span></div>
    <div class="stat accent"><b class="num" data-to="0">0</b><span>assessed by AI</span></div>
    <div class="stat"><b class="num" data-to="0">0</b><span>pages</span></div>
    <div class="stat"><b class="num" data-to="0">0</b><span>verified fixes</span></div>
  </div>
  <h2>Severity</h2><div class="bars" id="sev"></div>
  <p style="margin-top:16px" class="dim">
    <a href="/report/${encodeURIComponent(state.run.id)}">printable report</a> ·
    <a href="/vpat/${encodeURIComponent(state.run.id)}">VPAT draft</a> ·
    <a href="/runs/${encodeURIComponent(state.run.id)}/report.json">JSON</a></p>`;

function paintSummary() {
  const s = state.summary;
  const vals = [s.findings, s.deterministic, s.aiAssessed, s.pages, s.fixes.verified];
  $$('.stat b').forEach((b, i) => { b.dataset.to = vals[i] ?? 0; countTo(b, vals[i] ?? 0); });
  const max = Math.max(1, ...Object.values(s.bySeverity ?? {}));
  const sev = $('#sev');
  if (!sev) return;
  sev.innerHTML = ['critical', 'serious', 'moderate', 'minor']
    .map((k) => {
      const n = s.bySeverity?.[k] ?? 0;
      return `<div class="bar-row"><span class="badge ${k}">${k}</span><span class="bar"><i class="${k}" data-w="${(n / max) * 100}"></i></span><span class="n">${n}</span></div>`;
    })
    .join('');
  requestAnimationFrame(() => $$('#sev .bar > i').forEach((i) => (i.style.width = `${i.dataset.w}%`)));
}

// ---------------------------------------------------------- findings

function viewFindings(el) {
  // Even an empty state needs its heading — a page without an h1 is a finding
  // this tool reports on other people's sites.
  if (!state.run) return (el.innerHTML = `<h1>Findings</h1><div class="empty-mark">${CMARK}<p>Pick an audit in the sidebar, or start one with <b>+ New audit</b>.</p></div>`);
  el.innerHTML = `
    <h1>Findings</h1>
    <p class="dim mono">${esc(state.run.id)}</p>
    <div class="card row" style="margin:16px 0">
      <label class="field"><span>Search <span class="kbd">/</span></span>
        <input type="search" id="q" placeholder="rule, selector, description"></label>
      <fieldset><legend>Certainty</legend>
        <label><input type="checkbox" class="f-src" value="deterministic" checked> Measured</label>
        <label><input type="checkbox" class="f-src" value="ai" checked> Assessed</label>
      </fieldset>
      <fieldset><legend>Severity</legend>
        ${['critical', 'serious', 'moderate', 'minor'].map((s) => `<label><input type="checkbox" class="f-sev" value="${s}" checked> ${s}</label>`).join('')}
      </fieldset>
      <button class="btn" id="reset">Reset</button>
    </div>
    <p class="dim" id="count" role="status" aria-live="polite"></p>
    <ol class="findings" id="list"></ol>`;
  $('#q').addEventListener('input', debounce(paintFindings, 140));
  $$('.f-src, .f-sev').forEach((c) => c.addEventListener('change', paintFindings));
  $('#reset').addEventListener('click', () => {
    $('#q').value = '';
    $$('.f-src, .f-sev').forEach((c) => (c.checked = true));
    paintFindings();
  });
  paintFindings();
}

function paintFindings() {
  const q = ($('#q')?.value ?? '').trim().toLowerCase();
  const srcs = $$('.f-src:checked').map((c) => c.value);
  const sevs = $$('.f-sev:checked').map((c) => c.value);
  const list = state.findings.filter((f) => {
    if (!srcs.includes(f.source === 'ai' ? 'ai' : 'deterministic')) return false;
    if (!sevs.includes(f.severity)) return false;
    if (!q) return true;
    return [f.ruleId, f.domSelector, f.description, f.wcagCriterion, f.pageUrl].join(' ').toLowerCase().includes(q);
  });
  $('#count').textContent = `${list.length} of ${state.findings.length} findings`;
  // ponytail: cap at 300 rows. Virtualise only if a real audit makes it slow.
  // an <ol> may only contain <li> — even the empty state
  $('#list').innerHTML = list.slice(0, 300).map(findingHtml).join('') || '<li class="empty">Nothing matches those filters.</li>';
  $$('#list .head').forEach((b) =>
    b.addEventListener('click', () => {
      const li = b.closest('.finding');
      const open = li.hasAttribute('open');
      open ? li.removeAttribute('open') : li.setAttribute('open', '');
      b.setAttribute('aria-expanded', String(!open));
    })
  );
}

function findingHtml(f, i) {
  const ai = f.source === 'ai';
  return `<li class="finding ${ai ? 'assessed' : ''}" style="animation-delay:${Math.min(i, 16) * 16}ms">
    <button class="head" aria-expanded="false">
      <span class="badge ${ai ? 'ai' : 'det'}">${ai ? 'ASSESSED' : 'MEASURED'}</span>
      <span class="badge ${esc(f.severity)}">${esc(f.severity)}</span>
      <span class="wcag">${f.wcagCriterion ? `WCAG ${esc(f.wcagCriterion)} ${esc(f.wcagLevel ?? '')}` : 'unmapped'} · ${esc(f.ruleId)}</span>
      <span class="desc">${esc(f.description)}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <div class="panel"><div><div class="inner">
      <p class="dim" style="margin:0;font-size:var(--fs-sm)">${esc(f.pageUrl)}</p>
      ${f.domSelector ? `<p class="dim" style="margin:0;font-size:var(--fs-sm)">selector <code>${esc(f.domSelector)}</code></p>` : ''}
      ${f.computedStyles ? `<p class="dim" style="margin:0;font-size:var(--fs-sm)">measured <code>${esc(JSON.stringify(f.computedStyles))}</code></p>` : ''}
      <p class="dim" style="margin:0;font-size:var(--fs-sm)">confidence <span class="mono">${f.confidence}</span>${f.sources?.length > 1 ? ` · also reported by ${esc(f.sources.join(', '))}` : ''}${f.wcagCriterion ? ` · <a href="https://www.w3.org/WAI/WCAG22/Understanding/${esc(f.wcagCriterion)}">Understanding ${esc(f.wcagCriterion)}</a>` : ''}</p>
      ${f.htmlSnippet ? `<pre tabindex="0" aria-label="Current markup"><code>${esc(f.htmlSnippet)}</code></pre>` : ''}
      ${f.screenshotUrl ? `<img class="shot" src="${esc(f.screenshotUrl)}" alt="Screenshot of the flagged element">` : ''}
      ${f.fix ? `<p class="fix-label"><b>Proposed fix</b> <span class="badge ${f.fix.verification === 'verified' ? 'ok' : 'moderate'}">${esc((f.fix.verification ?? 'unverified').toUpperCase())}</span></p>
        ${f.fix.verification !== 'verified' ? '<p class="dim" style="margin:0"><b>Suggestion, not a verified fix.</b></p>' : ''}
        <pre class="after" tabindex="0" aria-label="Proposed replacement code"><code>${esc(f.fix.after)}</code></pre>
        <p class="dim" style="margin:0;font-size:var(--fs-sm)">${esc(f.fix.explanation ?? '')} ${esc(f.fix.verifyNotes ?? '')}</p>` : ''}
    </div></div></div>
  </li>`;
}

// ------------------------------------------------- history (versions)

async function viewHistory(el, alive = () => true) {
  const client = state.client ?? state.clients[0]?.id;
  if (!client) return (el.innerHTML = '<p class="empty">No clients configured.</p>');
  el.innerHTML = `<h1>History</h1>
    <p class="dim">Every run of <b>${esc(client)}</b> as a version. The change line is measured by
      fingerprint, so "fixed" means the finding is genuinely gone — not just renumbered.</p>
    <div id="rail"><div class="skeleton" style="height:90px;margin-bottom:12px"></div><div class="skeleton" style="height:90px"></div></div>`;
  try {
    const tl = state.timelines[client] ?? (state.timelines[client] = await api(`/api/timeline/${encodeURIComponent(client)}`));
    if (!alive()) return; // the user moved on while we were fetching
    $('#rail').outerHTML = `<ol class="rail" id="rail">${tl.map(railNode).join('') || '<li class="empty">No runs for this client yet.</li>'}</ol>`;
    $$('#rail [data-open]').forEach((b) => b.addEventListener('click', () => openRun(b.dataset.open)));
    $$('#rail [data-cmp]').forEach((b) =>
      b.addEventListener('click', () => {
        state.compare = [b.dataset.cmp, b.dataset.prev];
        setView('compare');
      })
    );
  } catch (err) {
    if (alive() && $('#rail')) $('#rail').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

const railNode = (n, i) => `<li class="${state.run?.id === n.id ? 'current' : ''}" style="animation-delay:${i * 50}ms">
  <div class="node">
    <div class="node-head">
      <span class="id" title="${esc(fullTime(n.startedAt))}">${esc(runTime(n))}</span>
      <span class="dim" style="font-size:var(--fs-xs)">${esc(ago(n.startedAt))}${duration(n.startedAt, n.finishedAt) ? ` · took ${duration(n.startedAt, n.finishedAt)}` : ''}</span>
      ${n.finishedAt ? '' : '<span class="badge serious">partial</span>'}
      <span class="acts">
        <button class="btn sm" data-open="${esc(n.id)}">Open</button>
        ${n.prev ? `<button class="btn sm" data-cmp="${esc(n.id)}" data-prev="${esc(n.prev)}">Compare to previous</button>` : ''}
      </span>
    </div>
    <div class="change">
      <span class="mono">${n.total} findings</span>
      ${n.delta ? `<span class="fixed">−${n.delta.fixed} fixed</span>
                   <span class="added">+${n.delta.new} new</span>
                   <span class="kept">${n.delta.stillBroken} carried over</span>` : '<span class="kept">first run — nothing to compare</span>'}
      ${n.verified ? `<span class="fixed">${n.verified} verified fixes</span>` : ''}
    </div>
  </div>
</li>`;

// ----------------------------------------------------------- compare

async function viewCompare(el, alive = () => true) {
  const runs = state.runs;
  const [head, base] = state.compare.length === 2 ? state.compare : [runs[0]?.id, runs[1]?.id];
  el.innerHTML = `<h1>Compare</h1>
    <div class="card row" style="margin:16px 0">
      <label class="field"><span>Base (older)</span><select id="c-base">${opts(base)}</select></label>
      <label class="field"><span>Head (newer)</span><select id="c-head">${opts(head)}</select></label>
      <button class="btn primary" id="c-go">Compare</button>
      <a class="btn" id="c-print" href="#" hidden>Printable diff</a>
    </div>
    <div id="diff" class="stats"></div>`;
  $('#c-go').addEventListener('click', () => doCompare());
  if (head && base && head !== base) await doCompare(alive);
}

const opts = (sel) => state.runs.map((r) => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.clientId)} · ${esc(runTime(r))}</option>`).join('');

async function doCompare(alive = () => true) {
  if (!$('#c-base')) return;
  const base = $('#c-base').value;
  const head = $('#c-head').value;
  if (base === head) return toast('Pick two different runs.');
  $('#diff').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const d = await api(`/api/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`);
    if (!alive() || !$('#diff')) return;
    $('#diff').style.gridTemplateColumns = 'repeat(auto-fit,minmax(300px,1fr))';
    $('#diff').innerHTML = diffColumn('Fixed', d.fixed, 'fixed') + diffColumn('New', d.new, 'added') + diffColumn('Still broken', d.stillBroken, 'kept');
    $$('#diff .num').forEach((n) => countTo(n, Number(n.dataset.to)));
    $$('#diff .rule-row').forEach((row) =>
      row.addEventListener('click', () => {
        const open = row.parentElement.classList.toggle('open');
        row.setAttribute('aria-expanded', String(open));
      })
    );
    const p = $('#c-print');
    p.href = `/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`;
    p.hidden = false;
  } catch (err) {
    toast(err.message);
  }
}

/**
 * 340 near-identical rows in a scroll box is unreadable — the eye loses its
 * place and every line looks the same. Group by rule, count them, and let the
 * reader open only the rule they care about. No inner scrollbar: the page
 * scrolls, so the reader keeps one scroll context instead of three.
 */
function diffColumn(title, items, cls) {
  const byRule = new Map();
  for (const f of items) {
    if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, []);
    byRule.get(f.ruleId).push(f);
  }
  const rules = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  const SHOWN = 12;

  // Truncate in the middle: CSS selectors share long prefixes, so cutting the
  // right-hand side leaves a column of identical-looking rows. The tail is what
  // tells them apart. Full value stays in the title.
  const where = (f) => f.domSelector ?? f.pageUrl ?? '';
  const short = (s) => (s.length <= 58 ? s : `${s.slice(0, 26)} … ${s.slice(-28)}`);
  const rule = ([ruleId, list]) => `<li class="rule">
    <button class="rule-row" aria-expanded="false">
      <span class="chev" aria-hidden="true">›</span>
      <span class="rule-name mono">${esc(ruleId)}</span>
      <span class="rule-count mono">${list.length}</span>
    </button>
    <ul class="rule-items">
      ${list.slice(0, SHOWN).map((f) => `<li title="${esc(where(f))}"><code>${esc(short(where(f)))}</code></li>`).join('')}
      ${list.length > SHOWN ? `<li class="dim">…and ${list.length - SHOWN} more</li>` : ''}
    </ul>
  </li>`;

  return `<div class="card diff-col ${cls}" style="animation:rise var(--t-3) var(--ease) both">
    <h2>${title}</h2>
    <b class="num mono" data-to="${items.length}">0</b>
    <p class="dim" style="margin:2px 0 10px;font-size:var(--fs-sm)">${rules.length} rule${rules.length === 1 ? '' : 's'}</p>
    <ul class="rules">${rules.map(rule).join('') || '<li class="dim" style="padding:8px 0">none</li>'}</ul>
  </div>`;
}

function toggleCompare(runId) {
  state.compare = [runId, ...state.compare.filter((x) => x !== runId)].slice(0, 2);
  renderTree();
  if (state.compare.length === 2) setView('compare');
  else toast('Shift-click a second run to compare.');
}

// ---------------------------------------------------------- settings

async function viewSettings(el, alive = () => true) {
  el.innerHTML = '<h1>Settings</h1><div class="skeleton" style="height:220px;margin-top:16px"></div>';
  const s = await api('/api/settings');
  if (!alive()) return;
  el.innerHTML = `<h1>Settings</h1>
    <p class="notice"><b>Where the key lives.</b> It is encrypted at rest in
      <code>sessions/.secrets.json</code> with the same vault as browser sessions — never written to
      <code>config.json</code>, never sent back to this page, never logged. An exported
      <code>GEMINI_API_KEY</code> environment variable always wins over the saved one.</p>

    <h2>Gemini API</h2>
    <div class="card" style="margin:8px 0 24px">
      <div class="row">
        <label class="field" style="flex:1 1 340px">
          <span>API key ${s.keyPreview ? `<span class="badge ok">saved</span>` : '<span class="badge moderate">not set</span>'}</span>
          <input type="password" id="s-key" placeholder="${s.keyPreview ? esc(s.keyPreview) : 'paste a key to save it'}" autocomplete="off">
        </label>
        <label class="field"><span>Tier</span>
          <select id="s-tier">
            <option value="free" ${s.tier === 'free' ? 'selected' : ''}>free — development only</option>
            <option value="paid" ${s.tier === 'paid' ? 'selected' : ''}>paid — required for client data</option>
          </select></label>
        <button class="btn primary" id="s-save">Save key</button>
        <button class="btn" id="s-test">Detect setup</button>
      </div>
      ${s.keyFromEnv ? '<p class="dim" style="margin:12px 0 0;font-size:var(--fs-sm)">Using the key from your <code>GEMINI_API_KEY</code> environment variable.</p>' : ''}
      <p class="dim" style="margin:12px 0 0;font-size:var(--fs-sm)">
        <b>Free tier is for development only.</b> Google may train on free-tier prompts — client data
        requires a paid key with <code>tier: paid</code>.</p>
    </div>

    <h2>Capabilities</h2>
    <p class="dim" style="font-size:var(--fs-sm)">
      <b>Detect setup</b> asks the API which models your key may use, ranks them, and tests the top
      candidates for structured output, vision and embeddings. The best working model is configured
      automatically — model names change often, so there is nothing here for you to keep up with.
      Features whose capability is missing are switched off rather than left to fail mid-run.</p>
    <div id="caps" class="card">
      <p class="dim" style="margin:0">Currently configured: <code>${esc(s.model || 'nothing yet')}</code>${s.embedModel ? ` · embeddings <code>${esc(s.embedModel)}</code>` : ''}.
      Press <b>Detect setup</b> to check it still works and re-pick if not.</p>
    </div>

    <details style="margin-top:24px">
      <summary class="dim" style="cursor:pointer;font-size:var(--fs-sm)">Advanced — rate limits and manual overrides</summary>
      <div class="card row" style="margin-top:12px">
        <label class="field"><span>Model override</span><input type="text" id="s-model" value="${esc(s.model)}" placeholder="leave to auto-detect"></label>
        <label class="field"><span>Embedding model</span><input type="text" id="s-embed" value="${esc(s.embedModel)}"></label>
        <label class="field"><span>Requests / minute</span><input type="number" id="s-rpm" min="1" value="${s.rpm}"></label>
        <label class="field"><span>Daily cap</span><input type="number" id="s-cap" min="1" value="${s.dailyCap}"></label>
        <button class="btn" id="s-save-advanced">Save overrides</button>
      </div>
    </details>`;

  const save = async (extra = {}) => {
    try {
      const body = { tier: $('#s-tier').value, ...extra };
      if ($('#s-key').value.trim()) body.apiKey = $('#s-key').value;
      await post('/api/settings', body);
      $('#s-key').value = '';
      toast('Saved');
      setView('settings');
    } catch (err) { toast(err.message); }
  };
  $('#s-save').addEventListener('click', () => save());
  $('#s-save-advanced').addEventListener('click', () =>
    save({
      model: $('#s-model').value, embedModel: $('#s-embed').value,
      rpm: Number($('#s-rpm').value), dailyCap: Number($('#s-cap').value),
    })
  );

  $('#s-test').addEventListener('click', async () => {
    const box = $('#caps');
    const btn = $('#s-test');
    btn.disabled = true;
    btn.innerHTML = `${CMARK} Detecting…`;
    btn.querySelector('.cmark')?.classList.add('is-loading');
    box.innerHTML = '<div class="skeleton" style="height:150px"></div>';
    try {
      const r = await post('/api/settings/test');
      box.innerHTML = `<ul style="list-style:none;margin:0;padding:0;display:grid;gap:8px">
        ${r.capabilities.map((c) => `<li style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <span class="badge ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'critical' : 'minor'}">${c.status}</span>
          <b>${esc(c.name)}</b><span class="dim">${esc(c.detail ?? '')}</span></li>`).join('')}
      </ul>
      ${r.autoConfigured ? `<p style="margin:14px 0 0"><b>Configured automatically:</b>
         <code>${esc(r.model)}</code>${r.embedModel ? ` and <code>${esc(r.embedModel)}</code>` : ''}
         — chosen from ${r.available} models your key can see, in ${r.ms}ms.</p>` : ''}
      ${r.tried?.length ? `<p class="dim" style="margin:8px 0 0;font-size:var(--fs-sm)">Tried in order:
         ${r.tried.map((t) => `<code>${esc(t.model)}</code> ${t.json ? '✓' : `✗ ${esc((t.error ?? '').slice(0, 60))}`}`).join(' · ')}</p>` : ''}
      ${!r.ok ? `<p class="dim" style="margin:8px 0 0;font-size:var(--fs-sm)">No usable model was found. Check the key, or the models your project has access to.</p>` : ''}
      ${r.features && r.features.vision === false ? '<p class="dim" style="margin:8px 0 0;font-size:var(--fs-sm)"><b>Alt-text quality is switched off</b> — it needs a model that accepts images.</p>' : ''}
      ${r.features && r.features.embeddings === false ? '<p class="dim" style="margin:4px 0 0;font-size:var(--fs-sm)"><b>The knowledge base falls back to keyword search</b> — no embedding model on this key.</p>' : ''}`;
    } catch (err) {
      box.innerHTML = `<p class="dim" style="margin:0">${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Detect setup';
    }
  });
}

// -------------------------------------------------------- run loading

async function openRun(runId, { switchView = true } = {}) {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) return;
  state.run = run;
  selectClient(run.clientId);
  $('#crumb-run').textContent = runTime(run);
  $('#crumb-run').title = fullTime(run.startedAt);
  $('#crumb-run').classList.remove('dim');
  renderTree();
  // Opening an audit leaves the composer — otherwise clicking a run in the
  // sidebar appears to do nothing. On boot we preload the newest run without
  // moving the user, so the app still opens on the composer.
  if (!switchView) { /* preload only */ }
  else if (state.view === 'history') render();
  else setView(state.view === 'compare' || state.view === 'new' ? 'overview' : state.view);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(runId)}/findings`);
    state.findings = data.findings;
    state.summary = data.summary;
    if (state.view === 'overview') paintSummary();
    if (state.view === 'findings') paintFindings();
  } catch (err) {
    toast(err.message);
  }
}

// --------------------------------------------------------------- jobs


function mountConsole() {
  const job = state.job;
  $('#console-wrap').hidden = false;
  $('#console').textContent = '';
  $('#job-name').textContent = `${job.command} · ${job.clientId}`;
  $('#job-continue').hidden = !job.interactive;
  $('#job-stop').hidden = false;
  setStatus('running');
  $('#job-continue').onclick = () => post(`/api/jobs/${job.id}/continue`).then(() => ($('#job-continue').hidden = true)).catch((e) => toast(e.message));
  $('#job-stop').onclick = () => post(`/api/jobs/${job.id}/stop`).catch((e) => toast(e.message));

  const budget = pageBudget(job.clientId);
  let scanned = 0;
  setMark('running', 0, 'audit running');

  const es = new EventSource(`/api/jobs/${job.id}/stream`);
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'line') {
      const span = document.createElement('span');
      span.className = `l ${m.stream === 'err' ? 'err' : /^\[/.test(m.line) ? 'sys' : ''}`;
      span.textContent = m.line;
      $('#console')?.append(span);
      if ($('#console')) $('#console').scrollTop = $('#console').scrollHeight;
      // Each scanned page fills the ring a little further.
      if (/^\s*✓ d\d/.test(m.line) && budget) {
        scanned++;
        setMark('progress', scanned / budget, `${scanned} of ${budget} pages scanned`);
      }
    } else if (m.type === 'browser') {
      openDock(job.id);
    } else if (m.type === 'needs-login') {
      showLogin(m.url, m.why);
    } else if (m.type === 'login-ok') {
      hideLogin();
      toast('Signed in — the run is continuing');
    } else if (m.type === 'stage') {
      const el = $('#job-stage');
      if (el) el.textContent = m.detail;
    } else if (m.type === 'blocked') {
      showBlocked(m.url, m.why);
    } else if (m.type === 'stalled') {
      showStall(m.seconds);
    } else if (m.type === 'unstalled') {
      $('#job-stall')?.remove();
      setStatus('running'); // output resumed — stop calling it stalled

    } else if (m.type === 'status') {
      setStatus(m.status);
      if (m.status !== 'running') {
        es.close();
        state.job = null;
        setMark('idle', 0, `audit ${m.status}`);
        hideLogin();
        closeDock();
        if ($('#job-continue')) $('#job-continue').hidden = true;
        if ($('#job-stop')) $('#job-stop').hidden = true;
        refresh();
      }
    }
  };
  es.onerror = () => es.close();
}

// ------------------------------------------------- live browser dock

function openDock(jobId) {
  if (state.browser?.jobId === jobId) return;
  closeDock();
  const img = $('#screen');
  const es = new EventSource(`/api/browser/stream?job=${encodeURIComponent(jobId)}`);
  state.browser = { jobId, es, meta: null };
  document.querySelector('.app').classList.add('has-dock');
  $('#dock').hidden = false;
  $('#dock-idle').innerHTML = `${CMARK} Connecting to the browser…`;
  $('#dock-idle').querySelector('.cmark')?.classList.add('is-loading');

  // Throttle by wall clock, not requestAnimationFrame: rAF is paused whenever
  // the tab is not actively rendering, which left the panel stuck on
  // "Connecting…" while frames were arriving perfectly well. A time check also
  // still protects the main thread from decoding every frame.
  let lastPaint = 0;
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'frame') {
      state.browser.meta = m.metadata;
      $('#dock-url').textContent = m.url ?? '';
      const now = Date.now();
      if (now - lastPaint < 80) return; // drop, another frame is along shortly
      lastPaint = now;
      img.src = `data:image/jpeg;base64,${m.data}`;
      img.classList.add('live');
      $('#dock-idle').hidden = true;
    } else if (m.type === 'page') {
      $('#dock-url').textContent = m.url ?? '';
    }
  };
  es.onerror = () => { $('#dock-idle').textContent = 'Browser disconnected.'; };
}

function closeDock() {
  state.browser?.es.close();
  state.browser = null;
  $('#dock').hidden = true;
  $('#screen').classList.remove('live');
  $('#dock-idle').hidden = false;
  document.querySelector('.app').classList.remove('has-dock');
}
$('#dock-close').addEventListener('click', closeDock);

/** Frame pixels → page CSS pixels, so a click lands where the user aimed. */
function toPageCoords(ev) {
  const img = $('#screen');
  const r = img.getBoundingClientRect();
  const meta = state.browser?.meta;
  const pageW = meta?.deviceWidth ?? img.naturalWidth;
  const pageH = meta?.deviceHeight ?? img.naturalHeight;
  return {
    x: ((ev.clientX - r.left) / r.width) * pageW,
    y: ((ev.clientY - r.top) / r.height) * pageH + (meta?.scrollOffsetY ?? 0),
  };
}

const sendInput = (body) =>
  state.browser && post('/api/browser/input', { job: state.browser.jobId, ...body }).catch(() => {});

$('#screen').addEventListener('click', (e) => {
  const { x, y } = toPageCoords(e);
  sendInput({ kind: 'click', x, y });
  $('#screen').focus(); // so typing goes to the page next
});
$('#screen').addEventListener('wheel', (e) => {
  const { x, y } = toPageCoords(e);
  sendInput({ kind: 'scroll', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: true });
$('#screen').addEventListener('keydown', (e) => {
  if (!state.browser) return;
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    return sendInput({ kind: 'text', text: e.key });
  }
  if (['Enter', 'Backspace', 'Tab', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) {
    e.preventDefault();
    sendInput({ kind: 'key', key: e.key, code: e.code, keyCode: e.keyCode });
  }
});
$('#screen').addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text');
  if (text) { e.preventDefault(); sendInput({ kind: 'text', text }); }
});

// --------------------------------------------------- login interrupt

function showLogin(url, why) {
  $('#lm-url').textContent = url ?? '';
  $('#lm-why').textContent = why ? `Reason: ${why}` : '';
  $('#login-modal').hidden = false;
  if (state.job) openDock(state.job.id);
  $('#lm-continue').focus();
}
function hideLogin() { $('#login-modal').hidden = true; }

$('#lm-continue').addEventListener('click', async () => {
  if (!state.job) return hideLogin();
  try {
    await post(`/api/jobs/${state.job.id}/continue`);
    hideLogin();
  } catch (err) { toast(err.message); }
});
$('#lm-stop').addEventListener('click', async () => {
  if (state.job) await post(`/api/jobs/${state.job.id}/stop`).catch(() => {});
  hideLogin();
});

/**
 * Bot protection is not something we work around — say what happened and what
 * the auditor can legitimately do about it.
 */
function showBlocked(url, why) {
  ask({
    title: 'The site blocked the audit browser',
    body: `<code>${esc(url)}</code> answered with a bot check (${esc(why)}).
      <b>Nothing was scanned</b> — a block page is not the site, and reporting its accessibility as
      the client's would be wrong.<br><br>
      This tool never tries to defeat a bot check. Re-run using a real browser window, where you are
      an ordinary visitor: set <code>ui.headlessJobs: false</code> in <code>config.json</code>, or
      audit a URL that is not behind the challenge.`,
    confirmText: 'Understood',
  });
}

// ------------------------------------------------------- the C mark

const CMARK = `<span class="cmark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">
  <circle class="track" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9"/></svg></span>`;

/** How many pages this job will visit, if we can know. Groups sum their members. */
function pageBudget(target) {
  const group = state.groups.find((g) => g.id === target);
  const ids = group ? group.clients : [target];
  const budgets = ids.map((id) => state.clients.find((c) => c.id === id)?.maxPages);
  return budgets.every((n) => n > 0) ? budgets.reduce((a, b) => a + b, 0) : null;
}

/**
 * The brand mark doubles as the job indicator: a static C when idle, a sweeping
 * one while working, and a filling ring once we know how many pages are coming.
 */
function setMark(stateName, progress = 0, label = '') {
  const mark = $('#brand-mark');
  if (!mark) return;
  mark.dataset.state = stateName;
  mark.style.setProperty('--p', String(Math.max(0, Math.min(1, progress))));
  $('#brand-status').textContent = label;
}

/** Silence is the symptom of every hang, so name it rather than spinning. */
function showStall(seconds) {
  if ($('#job-stall') || !$('#console-wrap')) return;
  const p = document.createElement('p');
  p.id = 'job-stall';
  p.className = 'notice';
  p.style.margin = '0 0 10px';
  p.innerHTML = `<b>No output for ${seconds}s.</b> The page may be hanging, or a model call may be
    waiting on a rate limit. Individual pages give up on their own after their budget; if this
    stays, press <b>Stop</b>.`;
  $('#console-wrap').prepend(p);
  setStatus('stalled');
}

function setStatus(s) {
  const b = $('#job-status');
  if (b) { b.textContent = s; b.className = `badge ${s === 'done' ? 'ok' : s === 'running' ? 'moderate' : s === 'stalled' ? 'serious' : 'critical'}`; }
  $('#dot').className = `status-dot ${s === 'running' ? 'busy' : ''}`;
  $('#conn').textContent = s === 'running' ? 'running' : s === 'stalled' ? 'no output' : 'idle';
}

async function refresh() {
  state.runs = await api('/api/runs');
  state.timelines = {};
  renderTree();
  if (state.view !== 'overview') render();
}

// --------------------------------------------------- command palette

const commands = () => [
  { group: 'action', label: 'New audit', run: () => setView('new') },
  ...TABS.map((t) => ({ group: 'view', label: `Go to ${t}`, run: () => setView(t) })),
  ...state.clients.map((c) => ({ group: 'client', label: `Client ${c.id}`, run: () => { selectClient(c.id); setView('history'); } })),
  ...state.runs.slice(0, 40).map((r) => ({ group: 'run', label: `${r.clientId} · ${runTime(r)} — ${r.total} findings`, run: () => openRun(r.id) })),
  { group: 'action', label: 'New audit', run: () => setView('new') },
  ...state.groups.filter((g) => !g.id.startsWith('__')).map((g) => ({
    group: 'group', label: `Run group ${g.label} (${g.clients.length} sites)`,
    run: () => startRun(g.id),
  })),
  { group: 'action', label: 'Toggle theme', run: () => $('#theme').click() },
  { group: 'action', label: 'Settings — Gemini API key', run: () => setView('settings') },
];

let paletteEl = null;
function openPalette() {
  if (paletteEl) return;
  const items = commands();
  paletteEl = document.createElement('div');
  paletteEl.className = 'palette-back';
  paletteEl.innerHTML = `<div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
    <input type="text" id="pal-q" placeholder="Jump to a run, client, or action…" autocomplete="off" aria-controls="pal-list">
    <ul id="pal-list" role="listbox"></ul></div>`;
  document.body.append(paletteEl);
  const input = $('#pal-q');
  const list = $('#pal-list');
  let cursor = 0;
  let shown = items;

  const draw = () => {
    const q = input.value.toLowerCase();
    shown = items.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 40);
    cursor = Math.min(cursor, Math.max(0, shown.length - 1));
    list.innerHTML = shown
      .map((c, i) => `<li role="option" id="pal-${i}" aria-selected="${i === cursor}"><span class="grp">${c.group}</span> ${esc(c.label)}</li>`)
      .join('') || '<li class="dim" role="option" aria-selected="false">no match</li>';
    $$('#pal-list li').forEach((li, i) => li.addEventListener('click', () => { closePalette(); shown[i]?.run(); }));
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, shown.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') {
      // preventDefault matters: closePalette() returns focus to the trigger
      // button, and without this the same Enter keypress then activates it and
      // reopens the palette — leaving an invisible overlay over the whole app.
      e.preventDefault();
      const c = shown[cursor];
      closePalette();
      c?.run();
    }
    if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  paletteEl.addEventListener('click', (e) => e.target === paletteEl && closePalette());
  draw();
  input.focus();
}
function closePalette() {
  paletteEl?.remove();
  paletteEl = null;
  $('#palette-btn').focus();
}
$('#palette-btn').addEventListener('click', openPalette);

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#q')?.focus(); }
  if (e.key === 'Escape' && paletteEl) closePalette();
  const n = Number(e.key);
  if (n >= 1 && n <= TABS.length) setView(TABS[n - 1]);
});

const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// --------------------------------------------------------------- boot

Promise.all([api('/api/runs'), api('/api/clients')])
  .then(([runs, cfg]) => {
    state.runs = runs;
    state.clients = cfg.clients?.length ? cfg.clients : [...new Set(runs.map((r) => r.clientId))].map((id) => ({ id, label: id }));
    state.groups = cfg.groups ?? [];
    state.client = state.clients[0]?.id ?? null;
    state.target = state.groups.find((g) => !g.id.startsWith('__'))?.id ?? state.client;
    if (state.client) selectClient(state.client);
    renderTree();
    setView('new'); // the app opens on the composer, like a new chat
    if (runs[0]) openRun(runs[0].id, { switchView: false });
  })
  .catch((err) => {
    $('#conn').textContent = 'offline';
    $('#tree').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    render();
    toast(err.message);
  });

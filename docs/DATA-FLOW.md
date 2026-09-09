# Contrast — Data Flow

**What this doc owns:** how data actually moves at runtime — what calls what, in what order, and what gets written where.
**Update it when:** a request path, pipeline step, or persistence step changes. Structure lives in [`ARCHITECTURE.md`](ARCHITECTURE.md); rationale in [`DECISIONS.md`](DECISIONS.md).

Every flow below is marked **[BUILT]** or **[PLANNED]**. Never describe a PLANNED flow as if it runs today.

---

## 1. Free public scan — **[BUILT]**

```
visitor → POST /scan {url}
  │
  ├─ normaliseUrl()            reject non-http(s), missing TLD
  ├─ assertPublicUrl()         DNS-resolve, refuse loopback/RFC1918/link-local/CGNAT
  │                            ↑ validation happens BEFORE quota is spent
  ├─ ipLimiter.check(ip)       3/hr per IP — only successful submissions cost quota
  ├─ gate.tryAcquire()         max 2 concurrent scans server-wide
  ├─ startRun(db, …)           → runId  (this return value is the ONLY id that exists)
  ├─ insertScanMeta()          hashed IP, device class, GeoIP country — raw IP discarded
  └─ 202 {runId, statusUrl, reportUrl}    ← responds immediately; scan continues in background

background: runScan(runId, seedUrl, {ip, ua})
  │
  ├─ loadActiveRules(db)       human-curated crawl rules
  ├─ openSession()             headless Chrome, read-only request guard on
  ├─ crawl()  ──per page──▶    matchesRule()?  yes → record incident, skip scanning
  │                            no  → scanPage() → axe + a11y tree + keyboard + screenshots
  │                                              → normalize() → findings → SQLite
  ├─ onAbandoned(reason)       → runs.notes + scan_incidents row
  ├─ finishRun()
  ├─ writeJson() / writeHtml() → runs/<runId>/report.{json,html}
  └─ jobs.set(runId, done)

visitor polls GET /status/:runId → {status, error, notes}
visitor opens GET /r/:runId      → regenerates HTML, 302 → /runs/<runId>/report.html
```

**No AI is called anywhere in this flow.** The free scanner has never held a Gemini key and does not import the AI modules.

---

## 2. Admin audit — **[BUILT]**

```
dashboard → POST /api/jobs {command, clientId, scope}
  │  csrfProblem(): require x-a11y-ui header + matching Origin
  │  COMMANDS allowlist: unknown command → 400, never reaches a shell
  ▼
startJob() spawns:  node src/cli.js run <client> --scope=scan|assess|full
  │
  ├─ applySecrets()   hydrate GEMINI_API_KEY from the encrypted vault into env
  ├─ crawl → scan → normalize                          (scope=scan stops here)
  ├─ AI-assess: 5 Gemini tasks, RAG over knowledge/     (scope=assess)
  ├─ generateFix → verifyFix → retry ≤3 → escalate      (scope=full, via src/graph/)
  └─ report: JSON + HTML + VPAT draft

stdout markers ([browser-ws], [needs-login], [blocked]) are parsed by the dashboard
to mirror the live browser and to know when the run is blocked on a human.
Job output streams to the browser over SSE: GET /api/jobs/:id/stream
```

**Failures persist.** A page that fails before scanning still gets a `pages` row; an abandoned crawl writes `runs.notes`; AI task errors escalate into `review_queue`. Nothing important lives only in terminal scrollback.

---

## 3. Funnel monitoring — **[BUILT]**

```
operator → contrast.<host>:4322  (Tailscale) → handleAuth() → password gate
  │
  ├─ GET /api/summary     aggregates over runs/public.sqlite:
  │                       scans/day, device, region, clicks, severity mix,
  │                       outcomes, top domains, duration p50/p95, retention,
  │                       journey (distinct people per funnel stage)
  ├─ GET /api/runs        paginated run list + scan_meta join
  ├─ GET /api/table/:name whitelisted table browser (+ ?format=csv)
  ├─ GET /api/incidents   unreviewed scan_incidents
  └─ POST /api/incidents/:id/rule → crawl_rules row, applied by flow 1 on the next scan
```

The rule ledger closes the loop: a failure flow 1 recorded becomes a rule flow 1 obeys.

---

## 4. Retention & cleanup — **[BUILT]**

```
every 6h (setInterval, unref'd)  →  cleanupOldRuns(db, 15)
   SELECT runs WHERE startedAt < now-15d
   → deleteRun(db, id)                   findings, pages, fixes, review_queue,
   │                                     scan_meta, scan_incidents, runs
   └─ rmSync(runDir(id), recursive)      screenshots + report files
```

Same two-step (rows, then folder) is used by the manual delete in the funnel panel — one code path, so they cannot drift.

---

## 5-7. Unshipped flows

Planned monetisation, caching and scheduling flows are commercial and live in
`docs/private/DIRECTION.md` (gitignored). Move a flow here only once it ships, and only
the parts describing behaviour a user can already observe.

---

## 8. Where a change usually has to land

| If you change… | Also update |
|---|---|
| A pipeline phase's output shape | `normalize.js`, `report/index.js`, `test/normalize.test.js` |
| A DB table | `SCHEMA` in `db.js`, `deleteRun()`'s table list, funnel `TABLES` allowlist |
| Anything the public server serves | Re-check the SSRF guard and the runId ownership check |
| An AI task | `ai/tasks.js`, `test/coverage.test.js` (keeps `OWN_CRITERIA` in step) |
| A mutating route | Add `csrfProblem()` — every existing one has it |
| Deleting a run | Rows **and** folder, or you leak disk |

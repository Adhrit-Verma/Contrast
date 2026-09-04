# CLAUDE.md — Contrast

Persistent context for future sessions. Read this before touching the codebase.

## What this is

Contrast is an AI-assisted web accessibility auditing tool for **teams of human auditors**,
not a replacement for them. It crawls a site (including behind a login), measures everything
a machine can prove (axe-core, the Chrome a11y tree, a keyboard trace, computed styles), asks
Gemini about the things machines are bad at (alt-text quality, link text, heading semantics,
form quality, reading order), writes remediation code grounded in a WCAG/ARIA/house-pattern
knowledge base, and re-verifies every fix in a fresh browser before calling it fixed.

Node 22+, ESM, no framework, no build step, no ORM. SQLite via `node:sqlite`. Vanilla JS/CSS
frontend that audits its own UI (`npm run audit:ui` — zero axe violations is a build condition).
Source-available, not open source — see `LICENSE`.

## The 7-phase architecture

| Phase | Where | What |
|---|---|---|
| 1. Crawl | `src/browser/` | manual login + encrypted session reuse, read-only request guard, robots-aware BFS |
| 2. Scan | `src/scan/` | axe + Lighthouse (off by default) + a11y tree + keyboard trace + screenshots + inventory |
| 3. Normalize | `src/scan/normalize.js` | tool output → `Finding[]`, dedupe axe/Lighthouse by selector+criterion |
| 4. AI-assess | `src/ai/` | 5 Gemini judgment tasks, RAG over `knowledge/` only (never over findings) |
| 5. Fix + verify | `src/ai/remediate.js`, `src/verify/` | generate remediation HTML, inject into a fresh page, re-scan, confirm resolved + no regressions |
| 6. Report | `src/report/` | JSON, printable HTML, run-to-run diff, VPAT/ACR first draft |
| 7. Orchestration | `src/graph/` | LangGraph state graph wrapping phases 1–6 as nodes; SQLite checkpointing; `interrupt()` for manual login and fix escalation |

Phases 1–6 are plain functions, independently callable from `src/cli.js` (`crawl`, `scan`,
`assess`, `report`, `vpat`, `diff`). Phase 7 (`audit` command / UI scope `full`) is the only
place they're wired into a cyclic graph — generateFix → verifyFix → retry (max 3 attempts,
config `graph.maxFixAttempts`) → escalateToHuman.

## Stack

- **Runtime**: Node.js 22+, ESM (`"type": "module"`)
- **Browser**: Puppeteer, `@axe-core/puppeteer`, `axe-core`, Lighthouse (programmatic, disabled by default — costs 25-46s/page for zero unique findings over axe)
- **AI**: `@google/generative-ai` (Gemini) — model auto-detected per API key, never hardcoded
- **Orchestration**: `@langchain/langgraph` + `@langchain/langgraph-checkpoint-sqlite`, Phase 7 only
- **Storage**: SQLite via `node:sqlite` (no native build, no ORM)
- **Frontend**: vanilla ES modules + CSS, no framework, no build step (`src/ui/public/`)
- **Tests**: `node --test`, no test framework dependency

## Current state per phase — audited 2026-09-04

All 7 phases are **code-complete and wired end-to-end**, not stubs. Caveats below are about
test coverage and this-environment verification, not missing functionality.

1. **Crawl — fully working, well tested.** Read-only guard (`guard.test.js`), robots/sitemap
   parsing (`robots.test.js`), session encryption round-trip (`robots.test.js`). `crawl.js`
   itself (BFS loop, relogin budget, block detection) has no dedicated unit test but is a thin
   composition of tested primitives.
2. **Scan — fully working, partially tested.** `normalize.js` (the place bugs actually hide)
   has 15 tests. `collect.js` (axe/Lighthouse/keyboard/inventory collectors) has no unit tests
   — it's mostly thin wrappers over Puppeteer/axe APIs that are hard to unit-test without a
   real page; `verify.test.js` exercises `runAxe` indirectly against a real browser.
3. **Normalize — fully working, heavily tested.** Dedupe logic, fingerprinting, severity
   merging, WCAG tag parsing all covered.
4. **AI-assess — code-complete, tested with a stub model, never run against the live API in
   this environment.** No `GEMINI_API_KEY` is configured here (no env var, no
   `sessions/.secrets.json`) — first real run will hit `"GEMINI_API_KEY is not set"`. Task
   logic, batching, and grounding are tested via `ai.test.js` with a fake Gemini client.
5. **Fix generation + verify — fully working, well tested.** `remediate.js` tested with a stub
   model; `verify/index.js` has 5 tests that launch a **real headless Chrome** and run real axe
   against a fixture page (verified / unresolved / regressed / unverified / error paths all
   covered).
6. **Report — fully working, untested.** `report/index.js` (JSON/HTML/diff/VPAT builders) has
   no dedicated test file. It's exercised implicitly by the CLI and UI but a broken report
   template would not be caught by `npm test`.
7. **Orchestration (LangGraph) — code-complete, zero automated test coverage.** No test file
   touches `src/graph/audit.js` or `src/graph/run.js`. The node logic is a direct wiring of the
   already-tested phase-1–6 functions, so it's *plausible*, but the graph edges, checkpointing,
   and interrupt handling have never been exercised by anything but manual runs (per the
   README's claims). This is the single biggest coverage gap in the repo.

**Test suite**: 68/68 pass (`npm test`), after `npm install` — `node_modules` was not present
before this audit (fresh checkout / never installed in this environment). Before installing,
5 of 9 test files failed outright with `ERR_MODULE_NOT_FOUND` (missing `puppeteer` and other
deps); after `npm install` all 68 pass, including the 5 real-Chrome tests in `verify.test.js`
(~7s total, real headless launches).

**Self-audit (`npm run audit:ui`)**: 0 violations, but only the **composer ("new audit")**
view was actually exercised in both themes — overview/findings/history/compare/settings were
all **skipped** ("no audits in the database to open") because this environment has no
`runs/audit.sqlite` yet. The README's "zero axe violations across six views" claim is not
independently re-verified here until a real run seeds the database.

## Render deployment

**There is nothing in this repository referencing Render** — no `render.yaml`, no
`Dockerfile`, no deploy config of any kind, in the working tree or in either of the 2 commits
in git history. Whatever deployment the checklist refers to was set up outside this repo
(dashboard-configured on Render, or in a different repo/branch never pushed here). There's
nothing here to diagnose "why it's down" — that needs to be answered from the Render dashboard
itself (or from wherever the deploy was actually configured), not from this codebase.

## Step 6 — public scan funnel

`src/public/server.js` + `src/public/ssrf.js` + `src/public/ipLimiter.js` +
`src/public/public/index.html`, added 2026-09-04. A deliberately **separate** small server from
`src/ui/server.js` (the admin dashboard) — reuses the same phase-1–6 library functions
(`crawl`, `scanPage`, the report writers) but shares zero runtime config or secrets:

- **No `config.json`, no `sessions/` mount.** Never reads the admin's Gemini key, never writes a
  named client. Each scan builds an ephemeral, in-memory client object per request.
- **Deterministic scan only — never calls Gemini.** The checklist's own text names "protects the
  Gemini cost cap" as the reason for the rate limit; the safer reading is this path has no cap to
  protect because it never makes an AI call at all.
- **SSRF guard is mandatory, not optional** (`ssrf.js`): resolves the hostname and refuses
  loopback/RFC1918/link-local/CGNAT addresses — including `100.64.0.0/10`, which is *also*
  Tailscale's own address range. Without that specific check, a visitor could paste this
  deployment's own tailnet address and have the public scanner reach the private admin
  dashboard from Step 5, which has no auth beyond tailnet membership. Known, accepted gap:
  checks the initial DNS resolution only, not full DNS-rebinding protection (documented with a
  `ponytail:` comment naming the upgrade path).
- **Separate SQLite db** (`runs/public.sqlite`) — but tracing the actual file-serving path
  showed a separate db alone wasn't enough: screenshots and `report.html` still land in the
  same shared `runs/<runId>/` folder on disk (a limitation of `scanPage()`'s hardcoded
  `runDir()`, unchanged to keep this a small diff). The real authorization boundary is in the
  static-file route itself: it checks `getRun(publicDb, runId)` before serving anything, so an
  admin runId 404s even though the file exists on disk — **verified empirically**, not just
  reasoned about, by fetching a real admin runId through the public server and confirming 404.
- **A real bug the "do this now" verification caught**: the rate limiter originally checked
  *before* URL validation, so two mistyped URLs or SSRF-blocked attempts burned a legitimate
  visitor's entire hourly quota before their first real scan. Fixed by validating first — only
  successful scan submissions consume the per-IP limit.
- **A second real bug the same verification caught**: `startRun()` generates its own runId
  internally and returns it; the original code generated a *second*, different id locally,
  returned that one to the client, and never stored it — every `/status/:runId` and `/r/:runId`
  request 404'd. Fixed to use `startRun()`'s return value as the single source of truth.
- **Caps**: `PUBLIC_MAX_PAGES` (default 5), `PUBLIC_RATE_LIMIT` (default 3/hour/IP),
  `PUBLIC_MAX_CONCURRENT` (default 2 scans at once, server-wide — bounds worst-case VPS load
  regardless of how many distinct IPs are involved). Client IP is read from
  `req.socket.remoteAddress` directly, not `X-Forwarded-For` — correct only because there is no
  reverse proxy in front yet (bare IP:port); the comment in `server.js` flags this as the one
  line that needs to change if a proxy is added later.
- **9 new tests** (`test/ssrf.test.js`, `test/ipLimiter.test.js`) — pure logic, no browser
  needed. End-to-end verified manually against a real target (`www.w3.org` WAI demo): SSRF
  blocking, the two bug fixes above, rate-limit enforcement, the shareable report link, and
  cross-service isolation from the admin's own runs.
- **No TLS, no domain** — bare IP:port, per the operator's explicit choice. Not a credential-risk
  surface (no logins, no API keys ever touch this service), just plaintext transport for which
  URL someone is checking. Revisit once a domain exists for Step 7.

## Step 7 — landing page

`src/public/public/index.html` (landing) + `scan.html` (renamed from the Step 6 tool page,
now at `/scan`), added 2026-09-04. Same public server, no new process — `server.js` gained two
route lines. Same brand tokens as `scan.html` and the admin dashboard's `tokens.css`, copied
inline rather than shared cross-process, for the same reason Step 6 did that.

Shows the differentiator instead of just claiming it: a two-line demo strip reproduces the
actual product's `MEASURED` (solid border) vs `ASSESSED` (dotted coral border) tagging with
real-shaped example findings, right under the hero. Pricing is the checklist's own fallback —
"Free during beta" — since there's no pricing model yet.

**Verified, not just built**: a real headless-Chrome check (not eyeballing the HTML) confirmed
the CTA button clears the fold with room to spare on three phone sizes (iPhone SE 375×667,
iPhone 14 390×844, a small Android at 360×640) and that `npm run audit:ui`'s own tool — axe-core
— reports zero violations on both the landing page and `/scan`, desktop and mobile. That check
caught one real bug: the first draft had no `<main>` landmark (content sat directly under
`<header>`/`<section>`/`<footer>` with nothing wrapping it) — fixed by wrapping the hero and
feature sections in `<main>`. A hard-coded `<br>` in the headline was also removed after a
screenshot showed it fighting with the browser's own wrapping at narrow widths, producing a
choppier four-line headline than letting it wrap naturally.

## Step 8 — public audit content

`docs/audits/` (9 files: 8 site writeups + `summary.md`), added 2026-09-04. Ran deterministic
scans (`node src/cli.js scan <client>`, no AI — no key configured) against 20 real Indian
company sites, 4 pages each, added as new `config.json` clients.

- **Result: 8 usable, 11 correctly blocked, 1 near-miss caught by hand.** Over half the 20
  targets refused automated traffic outright — Cloudflare/Akamai challenge pages or
  connection-level `ERR_HTTP2_PROTOCOL_ERROR` (HDFC Bank, India.gov.in, Myntra, Air India,
  Zomato, BookMyShow, NDTV, MakeMyTrip, Policybazaar, Croma, Nykaa). `looksBlocked()` correctly
  caught every one of these and abandoned the crawl rather than reporting on the challenge page.
- **A real gap `looksBlocked()` has, found while reviewing the raw data before publishing**:
  IndiGo's homepage returned a normal HTTP 200 with 8 axe findings that looked plausible (no
  title, no `lang`, broken image) — but the image path was
  `akamfailoverpage/indigologo.svg` and the page title was empty. It was Akamai's bot-defense
  *fallback* page, not IndiGo's real site, and it slipped past every existing check because
  `looksBlocked()` only flags 401/403/407/429/503 status codes or recognisable "checking your
  browser" text — a 200-status near-empty failover page matches neither. Excluded from the
  published writeup; this is a known, real gap worth closing (a heuristic on empty-title +
  near-empty body at 200 status, weighed against not false-flagging legitimate minimal pages)
  rather than something fixed under this step's time budget.
- **First real production run of the pipeline outside the WAI demo fixtures** — and it
  immediately validated the timeout lessons from Step 4: the first batch (screenshots on,
  default `enrichBudgetMs`) blew the 120s page budget on several image-heavy sites (Flipkart,
  Jio, SBI, IndiGo, Times of India all hit "moving on" mid-enrichment). Retried with
  `scan.screenshots: false` — the actual bottleneck — and every site that returned real content
  completed cleanly in under 30s.
- **Every number in every writeup was cross-checked against `runs/audit.sqlite` directly**
  (`getFindings()`), not against console output — console "0 findings" on a couple of runs in
  the first batch turned out to be misleading (the process was killed by an external test
  harness timeout before a backgrounded `scanPage()` call could finish and persist).
- Findings correctly separate **confirmed** (axe rule, no `:incomplete` suffix) from **flagged
  for human review** (`:incomplete` — axe couldn't fully resolve it, e.g. contrast against a
  background image) in every writeup's language — never overstated as certain.

## Deployment

`Dockerfile` + `docker-compose.yml` + `.github/workflows/ci.yml` + `DEPLOY.md`, added 2026-09-04.
No domain, no public TLS cert, and Basic Auth over plain HTTP was explicitly ruled out (sends
credentials in the clear) — so access is **Tailscale Serve**, not the open internet:
`src/ui/server.js`'s existing `127.0.0.1`-only bind (a deliberate safety property, left
untouched) is bridged to the operator's private tailnet with a real, auto-issued HTTPS
certificate. No password prompt; tailnet membership is the access control. Existing nginx on
the VPS is never touched — Tailscale Serve binds the `tailscale0` interface, not 80/443.

- **Base image**: `ghcr.io/puppeteer/puppeteer:25.10.0` — matched to the exact puppeteer version
  in `package-lock.json` (**not** the `^25.10.0` range in `package.json`, which can drift ahead
  of the image tag; check the lockfile before ever bumping this). Avoids hand-maintaining an
  apt-get list of Chrome's shared-lib dependencies.
- **Two real bugs caught by locally building and running the image before it ever reached a
  VPS**: (1) the base image tag was first set to `24.10.0` from a misremembered version — the
  lockfile actually has `25.10.0`, a full major ahead, needing a different bundled Chrome build
  entirely (real error: "Could not find Chrome (ver. 152.0.7977.75)"). (2)
  `ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` was originally declared *after* `RUN npm ci` —
  Docker `ENV` only affects instructions that come after it, so it had no effect during install.
  Both fixed; verified by actually launching Puppeteer and the dashboard inside the built image.
- **`network_mode: host`** (matching the pattern already used on this operator's VPS for another
  project) — required because the app's `127.0.0.1` bind is inside the container's own network
  namespace by default; only host networking makes "the container's loopback" and "the VPS's
  loopback" the same address, which `tailscale serve` then needs to be true.
- **`better-sqlite3`** (a transitive dependency of `@langchain/langgraph-checkpoint-sqlite`, used
  by Phase 7's checkpointer — not by Contrast's own `db.js`, which uses `node:sqlite`) has its
  native postinstall blocked by npm's install-scripts allowlist during `npm ci` in this image.
  Verified empirically that it still works (a prebuilt binary ships in the published package for
  this platform) rather than assuming it's broken from the warning text alone.
- **CI** (`.github/workflows/ci.yml`): runs the full test suite inside the *same* pinned
  puppeteer image on every push/PR (one verified Chrome environment, not two), then builds and
  pushes to GHCR on `main`. Auto-deploying straight to the VPS from Actions was deliberately left
  out — it would need an SSH private key stored as a repo secret, a real access-granting decision
  that shouldn't be a quiet default. `DEPLOY.md` documents the manual `docker compose pull && up
  -d` alternative and exactly what a `deploy` job would need if that changes later.
- **What's actually done vs. pending**: the image is built and verified locally (Puppeteer
  launches, the dashboard serves real HTML, `better-sqlite3` works) — none of the VPS-side steps
  (installing Docker/Tailscale, `docker compose up -d`, `tailscale serve`, a real end-to-end scan
  through the live URL) have run, since this session has no access to that VPS. `DEPLOY.md` is
  the runbook for the operator to execute those and self-verify against its own "done condition."

## Step 4 — Gemini hardening + failure diagnosability

- **Per-run cost cap**: `ai.perRunCap` (config default 300) stops a single audit — one
  `createGemini()` instance, one CLI invocation — from making unbounded real, billed calls even
  if a retry loop misbehaves. This sits alongside the pre-existing daily cap, which alone
  wouldn't stop same-day runaway spend. Enforced in `checkPerRunCap()` (`src/ai/gemini.js`),
  tested directly without mocking the SDK.
- **Retry/backoff now covers transient failures generally, not just 429.** `isTransient()`
  (`src/ai/limiter.js`) retries 5xx and dropped-connection errors (ECONNRESET, fetch failed,
  etc.) with the same exponential backoff + jitter as rate limits; genuine client errors (400,
  401, bad schema) still fail immediately. `isRateLimit` stays as the 429-specific check it was.
- **Bot-block and dead-URL handling was already implemented** (`looksBlocked()` in
  `session.js`, checked every page in `crawl.js`) — step 4 verified it empirically instead of
  building anything new. `test/blocked.test.js` runs a real headless browser against a local
  server serving a Cloudflare-style challenge page, and against a guaranteed-dead port: no
  exception in either case, nothing gets scanned, the reason is recorded as structured data,
  not just console text.
- **Structured logging — failures now survive past the run that produced them.** Two real gaps
  closed:
  1. A page crawl.js flags with `.error` (blocked, dead link, exhausted re-login) never reached
     the `pages` table before — only successfully scanned pages did. `recordUnscannedPages()`
     (cli.js) and the equivalent inline logic in `graph/audit.js`'s `crawlNode`/`scanPageNode`
     now write a `pages` row for every failure, so a run's per-page trace is complete without
     needing terminal scrollback.
  2. `runs.notes` (an existing, previously-unused schema column) now records *why* a run came
     back thin — `crawl.js`'s new `onAbandoned` callback wires blocked/relogin-exhausted crawls
     into it from all three call sites (`scan`, `run`, and the graph). `node src/cli.js runs`
     prints it; the HTML report shows a red notice banner when a run didn't complete as
     expected.
  3. AI task errors from the CLI paths (`assess`, `run --scope=assess|ai`) are now escalated
     into `review_queue` via the new shared `insertReview()` (`src/db.js`, extracted from what
     was a graph-only closure) — previously only the graph path persisted these; the CLI paths
     only printed them to a console that's gone once the job ends.

## Gemini API key handling

- **Never in `config.json`** and never hardcoded. Two sources, env wins:
  1. `GEMINI_API_KEY` environment variable (always wins if set)
  2. `sessions/.secrets.json`, AES-256-GCM encrypted with the same key vault used for browser
     sessions (`src/secrets.js`, `src/browser/session.js`). Set via the dashboard's Settings
     tab (`POST /api/settings`) or `setSecret()`.
- `applySecrets()` runs at the top of `src/cli.js` on every invocation, hydrating
  `process.env.GEMINI_API_KEY` from the encrypted store before any command runs — so every
  child process the dashboard spawns inherits it without it ever touching `config.json`.
- **Rate-limited**: yes, thoroughly (`src/ai/limiter.js`) — sequential queue (never
  `Promise.all`), token-bucket RPM (`ai.rpm`, default 15), a **daily cap**
  (`ai.dailyCap`, default 1000, hard-rejects once hit), exponential backoff with jitter on 429
  (`ai.maxRetries`, default 5). Virtual-clock tested, no real waiting in tests.
- **No per-scan cap** — only the global daily cap exists. A single pathological run could
  exhaust the whole day's budget. (Checklist step 4 territory, not a step-1 bug.)
- **Tier flag is advisory, not enforced**: `ai.tier: "free"` (default) prints a loud warning
  on every `createGemini()` call telling the operator not to scan client data on it, but
  nothing in the code blocks a free-tier run. Setting `ai.tier: "paid"` silences the warning;
  there is no code-level gate preventing a free-tier scan of real client data.
- Content-hash caching (`ai_cache` table) means an unchanged element is never re-sent to the
  model across runs.
- In this environment: **no key is configured** (no env var, no `sessions/` directory at all)
  — AI features (`assess`, `full` scope, `audit`) will fail immediately with a clear error
  until one is added via Settings or `GEMINI_API_KEY`.

## Accuracy harness

`npm run accuracy` (`scripts/accuracy.mjs`) runs the deterministic scanner against the
[W3C ACT Rules](https://act-rules.github.io/) community test cases — free, public,
pre-labelled fixtures with a known expected outcome per WCAG criterion — and computes
precision/recall per criterion. Results land in `runs/act/accuracy.json`, and every
missed detection or false alarm in `runs/act/disagreements.json`.

```bash
npm run accuracy                    # bounded sample (120 cases)
node scripts/accuracy.mjs --all     # all 931 labelled cases (~30 min)
node scripts/accuracy.mjs --rule 6cfa84
node scripts/accuracy.mjs --refresh # re-fetch the test case index
```

Measurement decisions worth knowing:

- **It measures axe-core.** The deterministic layer *is* axe, so this is not an independent
  engine's score. A criterion at recall 0 means "no automated rule covers this", which is
  exactly the signal the coverage section needs.
- **A literal "Contrast vs axe-core" cross-check would be tautological** — they are the same
  results. The meaningful disagreement is tool vs. ACT's labelled ground truth, which is what
  `disagreements.json` records.
- **axe's `incomplete` does not count as a detection.** Scoring "could not decide" as a catch
  would flatter the numbers; it is tracked separately.
- **The tree and keyboard detectors are excluded.** ACT fixtures are DOM fragments, so "no main
  landmark" fires on nearly all of them — a corpus artifact that would swamp 1.3.1 with false
  positives.
- **4.1.1 Parsing scores recall 0 by design.** WCAG 2.2 removed it and `knowledge/wcag/criteria.md`
  says not to report against it; axe dropped its duplicate-id rules accordingly. The ACT corpus
  still labels those cases, so they register as misses. Correct behaviour, not a gap.

## WCAG coverage in reports

`wcagCoverage()` / `automatedCriteria()` in `src/report/index.js` classify every catalogued
criterion as **findings**, **checked-clean**, or **manual-only**, so a report with few findings
can never read as a clean bill of health. The automated set is derived from axe's own rule
metadata (never a hand-maintained table) plus `OWN_CRITERIA` for the keyboard/tree/AI detectors,
kept in step with `ai/tasks.js` by `test/coverage.test.js`.

Against the shipped knowledge base: **23 of 86 catalogued criteria (27%) have an automated rule
that actually runs.** Rules axe ships but does not run by default — experimental, deprecated, and
AAA-only — are excluded, because counting them claims checks that never happen. The ACT harness
caught that overstatement empirically (1.4.6, 2.5.3 and 1.3.4 each had a "rule" detecting nothing
across the whole corpus).

The VPAT now distinguishes "a rule ran and found nothing" from "no rule can cover this"; both
still say *Not Evaluated*, because automated silence is never conformance.

### Measured accuracy — full ACT corpus, 2026-09-04

931 labelled cases, 38 criteria, 0 load errors: **87% precision, 37% recall** overall
(130 TP / 20 FP / 222 FN).

| | |
|---|---|
| Perfect (P and R = 100%) | 1.3.5, 1.4.12, 2.1.1, 2.2.1 |
| Strong precision, partial recall | 1.1.1 (100/55), 1.4.3 (100/63), 2.4.2 (100/71), 3.1.2 (100/69), 2.4.4 (100/50), 1.4.4 (100/44) |
| Worth fixing | **3.1.1 — 56% precision** (8 false alarms, all `lang`/`xml:lang` matching); **4.1.2 — 74% precision** (10 false alarms); 1.3.1 — 88% |
| Zero recall, no rule runs | 1.2.x, 1.3.3, 1.3.4, 1.4.5/1.4.6/1.4.9, 2.1.2/3/4, 2.2.2, 2.2.4, 2.4.1, 2.4.6, 2.4.9, 2.5.3, 2.5.4, 3.2.5, 3.3.1 |
| Zero recall by design | **4.1.1** — WCAG 2.2 removed it; axe dropped duplicate-id accordingly. The corpus still labels it, so it scores as 6 misses. Correct behaviour. |

The 37% recall is the honest headline and is *not* a defect to fix: most misses are criteria no
automated rule covers, which is precisely what the report's coverage section now says out loud.
Recall against criteria that do have a running rule is far higher.

## Status log

*(newest first)*

- **2026-09-04** — Step 8 complete: ran real deterministic scans against 20 major Indian
  company sites, published 8 usable writeups + a summary in `docs/audits/`. 11 sites correctly
  triggered the bot-protection safety stop; 1 (IndiGo) returned a 200-status Akamai failover
  page that `looksBlocked()` didn't catch — found by hand before publishing and excluded, now
  logged as a real, open gap in that detector. Every published number was cross-checked
  directly against `runs/audit.sqlite`, not console output. 87/87 tests unaffected (content +
  config only, no library code changed).

- **2026-09-04** — Step 7 complete: added the landing page at `/` on the same public server from
  Step 6, moved the scan tool to `/scan`. Verified with a real headless-Chrome check (not just
  reading the HTML) that the CTA clears the fold on three phone sizes and that axe-core reports
  zero violations on both pages, both widths — which caught a real missing-`<main>`-landmark bug
  before it shipped. 87/87 tests still pass (no library code changed, just the public site).

- **2026-09-04** — Step 6 complete: built the public scan funnel as a fully separate server
  (`src/public/`) with an SSRF guard, per-IP rate limiting, a global concurrency gate, and a
  minimal standalone paste-a-URL page. Real end-to-end verification (not just unit tests) caught
  two genuine bugs — rate-limit checked before validation (typos burned quota), and a runId
  mismatch that made every status/report lookup 404 — both fixed and re-verified. Confirmed by
  fetching a real admin runId through the public server that the two services' run histories are
  actually isolated, not just nominally separate. 87/87 tests pass. Bare IP:port, no TLS, per the
  operator's own choice; revisit before Step 7 needs a real domain anyway.

- **2026-09-04** — Step 5 in progress: added Dockerfile, docker-compose.yml (`network_mode:
  host`), .github/workflows/ci.yml (test + build/push to GHCR), and DEPLOY.md (Tailscale Serve
  runbook — no domain, no public TLS, Basic Auth over HTTP explicitly rejected as unsafe).
  Built and verified the image locally: Puppeteer launches, dashboard serves real HTML,
  better-sqlite3's native binary works despite an npm install-scripts warning. Caught and fixed
  two real bugs pre-VPS: wrong base image tag (24.10.0 vs. the lockfile's actual 25.10.0) and an
  ENV-declared-after-RUN ordering bug that silently disabled the Chromium-skip flag. VPS-side
  steps (Docker/Tailscale install, first boot, live end-to-end scan) are documented but not yet
  run — no access to that VPS from this session. 78/78 tests still pass (infra-only changes).
- **2026-09-04** — Step 4 complete: added `ai.perRunCap` (default 300, alongside the existing
  daily cap), broadened retry/backoff from 429-only to all transient failures (5xx, dropped
  connections) via `isTransient()`, and closed two real structured-logging gaps — pages that
  fail before scanning now get a `pages` row instead of vanishing, and `runs.notes` (an
  existing unused column) now records why a crawl was abandoned. AI task errors from the CLI
  paths now escalate to `review_queue` like the graph path already did, via a newly shared
  `insertReview()`. Verified bot-block and dead-URL handling empirically with a new
  `test/blocked.test.js` (real browser, local server — no dependency on a third party's
  defenses still being up later) rather than building new mechanism, since it already worked.
  78/78 tests pass.
- **2026-09-04** — Step 3 complete: added `scripts/accuracy.mjs` (ACT Rules precision/recall
  harness) and WCAG coverage classification in reports (JSON + HTML + VPAT remarks). Measured
  87% precision / 37% recall over 931 ACT cases. The harness immediately earned itself by
  catching a real overstatement bug in `automatedCriteria()` — it had been counting axe's
  experimental, deprecated and AAA rules, which never run; coverage dropped from a claimed 34%
  to a true 27%. 73/73 tests pass. Weakest real result: 3.1.1 at 56% precision (`lang` matching
  false alarms), then 4.1.2 at 74%.
- **2026-09-04** — Step 2: skipped, per its own "skip if step 1 found everything solid" clause.
  No phase was partially working or stubbed — nothing to fix. The one real gap (zero test
  coverage on `src/graph/`) isn't cheaply fixable without either an invasive refactor to
  export internal node functions or a heavy real-browser+real-Gemini integration test, so it
  wasn't manufactured into this step. Worth a dedicated task later if it becomes load-bearing.
- **2026-09-04** — Step 1 complete: full repo audit, `CLAUDE.md` created. All 7 phases
  code-complete; 68/68 tests pass after `npm install` (was not previously installed here).
  Confirmed no Render config exists in this repo. Confirmed Gemini key is encrypted-at-rest
  or env-var only, rate-limited with a daily cap but no per-scan cap, and tier enforcement is
  advisory only. Biggest gap found: `src/graph/` (Phase 7 orchestration) has zero automated
  test coverage.

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

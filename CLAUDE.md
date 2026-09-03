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

## Status log

*(newest first)*

- **2026-09-04** — Step 1 complete: full repo audit, `CLAUDE.md` created. All 7 phases
  code-complete; 68/68 tests pass after `npm install` (was not previously installed here).
  Confirmed no Render config exists in this repo. Confirmed Gemini key is encrypted-at-rest
  or env-var only, rate-limited with a daily cap but no per-scan cap, and tier enforcement is
  advisory only. Biggest gap found: `src/graph/` (Phase 7 orchestration) has zero automated
  test coverage.

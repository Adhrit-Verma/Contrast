# Contrast — Timeline

**What this doc owns:** when things changed, newest first.
**Update it when:** you ship anything — a feature, a fix, a decision, a deploy. One entry, same shape, at the top of the current day. This is the running record; [`DECISIONS.md`](DECISIONS.md) holds the reasoning, [`ARCHITECTURE.md`](ARCHITECTURE.md) the current shape.

**Entry format:**

```
### YYYY-MM-DD — headline
**Shipped.** what changed, in one or two lines
**Caught.** any real bug this work found (keep these — they are the most useful part)
**Decision.** #n if one was recorded
```

Keep "Caught" honest. The bug list is what stops the same mistake twice.

---

### 2026-09-09 — Documentation set; commercial docs split out of the public repo
**Shipped.** Created `docs/ARCHITECTURE.md`, `docs/DATA-FLOW.md`, `docs/DECISIONS.md`, `docs/TIMELINE.md`, and a documentation map in `CLAUDE.md`. Commercial material moved to `docs/private/` and gitignored. Added the missing `funnel` and `set-password` npm scripts.
**Caught.** `CLAUDE.md` still claimed 68/68 tests (actually 120). `package.json` was missing two commands that already existed. Research and planning drafts were about to be committed to a **public** repo — caught before the commit, not after.
**Decision.** #18 (degrade, never go dark), #19 (public-URL-only cache), #21 (provider behind a router). Commercial decisions recorded privately.

### 2026-09-08 — Login, deeper funnel panel, config untracked (`3dd18b1`)
**Shipped.** `src/auth.js` — scrypt password + HMAC-signed cookie over both private panels, inert until set. Funnel panel grew to five sections with real charts (scans/day, conversion funnel, severity mix, hour-of-day, top domains, duration percentiles), a whitelisted table browser with CSV export, per-run drill-down, and rule deletion. `config.json` untracked, seeded from `config.example.json`.
**Caught.** A funnel chart claiming "490% continued" because it mixed unique visitors with total scans — every stage now counts distinct people. An invalid `--sev-ok-fg` token painting bars invisible. Three axe violations in our own panel: missing `h1`, unlabelled action columns, a keyboard-unreachable scroll region. A rate limiter consulted *after* the password check, which made it decorative.
**Decision.** #11, #12, #13.

### 2026-09-08 — Funnel monitoring split into its own service (`ebe6c3f`)
**Shipped.** Moved the panel out of the admin dashboard into `src/funnel/server.js` (port 4322, 127.0.0.1). Serves `tokens.css`/`app.css` straight from `src/ui/public/` so the design system cannot drift.
**Caught.** `/api/funnel/summary` was still answering on the dashboard until the stale process was restarted — a reminder that route removal needs a restart to verify.

### 2026-09-08 — Funnel monitoring panel, first version (`1d546bc`)
**Shipped.** `scan_meta`, `click_events`, `scan_incidents`, `crawl_rules` tables; device classifier; offline GeoIP; 15-day auto-cleanup; incident → rule ledger applied at scan time.
**Caught.** `deleteRun()` did not clear the new run-scoped tables, which would have leaked rows past cleanup. A double `JSON.parse` in the SSRF catch path that would have thrown inside the error handler.

### 2026-09-06 — Funding meter and support asks (`d64c953`)
**Shipped.** Goal ladder tied to real backlog items, `/api/funding`, support asks at scan-complete, report footer, and landing page — public surfaces only; admin reports stay clean.
**Caught.** Mobile overflow on the report: `<code>` selectors, long URLs and coverage cells had nothing to break on and pushed the document sideways at 390px.

### 2026-09-06 — Report and scan page redesign (`c173ba9`)
**Shipped.** Brand hero, severity ring, staged scan narrative.
**Caught.** Findings were double-collapsed behind two nested `<details>`, defeating the report's purpose. A bento-grid span miscalculation. "1 pages scanned".

### 2026-09-04 — VPS Chrome sandbox fix (`77e7234`)
**Shipped.** `cap_add: SYS_ADMIN` so Chrome's own sandbox works in Docker — chosen over `--no-sandbox` precisely because these services render third-party pages.

### 2026-09-04 — Step 9: launch assets (`8cc260f`)
**Shipped.** Product Hunt copy, G2/Capterra listing, IT-services pitch, cold email template.
**Caught.** The first cold email draft read aloud in 17–19s against a 10–15s target; cut from 42 to 28 words and re-measured at 11.2–12.9s before shipping.

### 2026-09-04 — Step 8: 20 real Indian sites audited
**Shipped.** 8 usable writeups + summary in `docs/audits/`.
**Caught.** 11 of 20 sites correctly triggered the bot-protection stop. IndiGo returned a **200-status Akamai failover page** that `looksBlocked()` missed entirely — a real, still-open gap in blocked-page detection. Console "0 findings" was misleading on two runs; every published number was re-checked against SQLite directly.

### 2026-09-04 — Steps 5–7: Docker, CI, public funnel, landing page
**Shipped.** Dockerfile, compose, GitHub Actions CI, `DEPLOY.md`; the public scanner (`src/public/`) with SSRF guard, per-IP limits and concurrency gate; the landing page.
**Caught.** Base image tag was a full major version behind the lockfile ("Could not find Chrome"). `ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` declared *after* `RUN npm ci`, silently doing nothing. Rate limit checked before URL validation, so two typos burned a visitor's hourly quota. `startRun()`'s runId discarded in favour of a second, never-stored id — every status and report lookup 404'd. CI hung forever because Chrome refuses to run its sandbox as root.
**Decision.** #8, #9, #10.

### 2026-09-04 — Steps 3–4: accuracy harness, Gemini hardening
**Shipped.** `scripts/accuracy.mjs` over the W3C ACT corpus; WCAG coverage classification in reports; per-run cost cap; retry/backoff broadened past 429; structured logging so failures survive the run.
**Caught.** `automatedCriteria()` was counting axe's experimental, deprecated and AAA-only rules — rules that never run. True coverage was 27%, not the claimed 34%.
**Decision.** #6.
**Measured.** 931 ACT cases: 87% precision, 37% recall. Weakest: 3.1.1 at 56% precision.

### 2026-09-04 — Step 1: full repo audit, `CLAUDE.md` created
**Shipped.** All 7 phases verified code-complete; 68/68 tests passing after first `npm install` in this environment.
**Caught.** `src/graph/` (orchestration) has zero automated test coverage — still the largest gap.

### 2026-08-14 — Initial commit (`6b65ab4`, `4b940b7`)
**Shipped.** The 7-phase pipeline, dashboard, source-available license.
**Decision.** #1, #5, #7.

---

## Standing gaps

Carried forward until closed. Add here when you find one you are not fixing today.

| Gap | Since | Note |
|---|---|---|
| `src/graph/` has no automated tests | 2026-09-04 | Largest coverage gap; needs real-browser + real-API integration test |
| `looksBlocked()` misses 200-status failover pages | 2026-09-04 | Found via IndiGo/Akamai; heuristic on empty-title + near-empty body at 200 |
| SSRF guard checks initial resolution only | 2026-09-04 | Not full DNS-rebinding protection |
| No TLS on the public scanner | 2026-09-04 | Bare IP, no domain yet |

Commercial open items are tracked in `docs/private/DIRECTION.md`.

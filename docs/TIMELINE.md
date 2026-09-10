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

### 2026-09-10 — Editorial design system, a real /plans page, demonstrative motion
**Shipped.** Replaced the landing page's visual language wholesale and extracted it into `src/public/public/site.css` + `site.js`, now shared by `/` and the new `/plans`. Four rules govern it: structure over atmosphere (depth is a change of plane — ink, canvas, paper — plus a real column grid); rules not shadows (one shadow survives, on the sticky bar, and only once it has lifted); type does the work (the product's own measurements set large in mono are the only ornament); and motion demonstrates or it does not ship. Out went the pulsing "free during beta" pill, three radial-gradient glows, the masked hairline grid, the marquee, the parallax card stack, the floating stat chip, the oversized ghost numerals, the sliding arrows, every hover-lift, and the scroll-reveal. In came a hero animation that replays one finding through crawl → measure → assess → verify in the shapes the pipeline actually emits, and three on `/plans` that run the same 24-page site through each plan so the difference is shown rather than claimed. `/plans` also carries a row-by-row comparison table instead of three lookalike cards. The generated report was brought onto the same system — 19 radii normalised to one, all shadows and hover-lifts removed — since it is the artifact the site produces and cannot run a different design language.
**Caught.** Four real bugs. (1) `/plans` jumped `h1` → `h3` in the plan columns, an axe `heading-order` failure. (2) The hero demo grew from 328px to 501px as content accumulated, reflowing everything below it on every fourteen-second loop — found by sampling the height across a full cycle, not by watching. Fixed by having `loopDemo` measure its own final frame and pin that height, re-measured on resize, rather than hard-coding a number per breakpoint. (3) `prefers-reduced-motion` pinned the frame containing the diff block and immediately exposed `scrollable-region-focusable`: a horizontally scrolling `<pre>` no keyboard could reach. The same latent bug was in the report's snippets, which only become scrollable once long enough to overflow. (4) Fixing that with `role="region"` + a label on every report snippet produced dozens of identically-named landmarks — `landmark-unique`. Focusability alone was the requirement.
**Decision.** #30 (the design system's four rules), #31 (motion demonstrates or it does not ship).

### 2026-09-10 — Report grouped by issue; landing page rebuilt around depth, plans and donation
**Shipped.** The report's hero now names the **site that was scanned**, not the internal `clientId` — a free scan used to headline itself "contrast-public", which told the reader nothing. It gained Share / Save-as-PDF / JSON buttons (Web Share API, clipboard fallback, `window.prompt` last resort) and a real print stylesheet. Findings are grouped **by issue, not by page**: one card per distinct rule+severity, laid out as a two-column masonry with severity/source filter chips and an expand-all toggle. The landing page was rebuilt on a layered dark band (ink field → accent light → hairline grid → cards that break the band edge), every text link replaced with a button, a measured-facts panel filling the empty half of the method heading, a three-column plans section (one live, two "coming soon" with no figure and no date), and a two-column support section where picking a suggested amount says in words what that amount pays for. Motion throughout is `IntersectionObserver` reveals, a pausable proof marquee and a pointer-parallax hero stack — all inert under `prefers-reduced-motion`.
**Caught.** Four real bugs, all from running a browser rather than reading the markup. (1) The `.band` wrapper's `</div>` closed **before** `</main>`, so the browser ended the main landmark early and half the page sat outside it — axe's `region` rule found it. (2) `--on-ink-3` is 4.9:1 on solid ink, but the nav composites at 90% over the light canvas, so "by Vimoksh" actually rendered on `#302f2e` at **3.87:1** — the third time an opacity/translucency has quietly broken a contrast floor here, and the first where the token itself was correct. (3) The new hero mark leaked **"by Vimoksh" into admin reports**, which an auditor hands to their own client — now behind the same gate as the colophon. (4) The first pass at issue cards rendered 12 instances each and opened two of them: one card measured **3,570px tall**, making the report *longer* than the version it replaced. Three instances, one card open.
**Also.** A funding goal advertised the 200-status failover detector that shipped earlier the same day; rewritten to the half of that gap still open.

### 2026-09-10 — Closed three standing gaps: failover pages, SSRF redirects, graph routing
**Shipped.** `looksBlocked()` now catches bot-defense fallback pages that answer HTTP 200 with no challenge wording — by vendor asset marker (`akamfailoverpage`, Incapsula, cdn-cgi, PerimeterX), or by three weak signals together (no title AND under 200 chars AND no navigation). The SSRF guard gained `createHostGuard()`, wired into the public scanner's request interceptor, so every redirect and subresource re-resolves rather than trusting the one check on the URL the visitor typed; it fails closed if the check itself throws. `src/graph/`'s three routing decisions are extracted, named and tested. 22 new tests, 181/181 passing.
**Caught.** Nothing new broke, but the false-positive direction got more test weight than the true-positive one: over-flagging a real page would silently discard a customer's actual findings, which is worse than missing a failover shell. Four tests cover pages that must *not* be flagged. Also dropped a test that asserted on LangGraph's internal spec shape — testing the library, not our logic.
**Decision.** #26 (a blocked-page heuristic must fail toward scanning).

### 2026-09-10 — Wired the AI router into both run paths; unified the C mark
**Shipped.** `cli.js` and `graph/run.js` now build the provider + budget instead of a bare Gemini client, so the paid model, free fallback, spending ceiling and degrade path apply to every assessment. Embeddings stay on Gemini (the knowledge base is indexed with them). Both paths print remaining budget before assessing. The public pages, generated reports, audit writeups, login page and funnel panel all use the dashboard's animated C mark, and the scan page's mark sweeps while a scan runs. 7 new wiring tests, 159/159 passing.
**Caught.** The previous session's modules were **dead code** — nothing imported `provider.js`, `budget.js` or `openai.js`, and `monthlyCeilingUsd` was a **decorative control**: settable in the UI, persisted to config, read by nothing. A ceiling of $5 would have had no effect. Found only by grepping for importers rather than trusting the summary. Also: the new Vimoksh footer used `opacity:.8` and failed contrast at 3.41:1 — the same mistake as the ghost cards earlier the same day, caught the same way.
**Decision.** #25 (a control that is not read is worse than an absent one).

### 2026-09-10 — Key configuration, "coming soon" placeholders, Vimoksh colophon
**Shipped.** `.env.example` as the single place a fresh install needs to touch — everything else already has a working default. OpenAI key + monthly ceiling + model IDs are now settable from the dashboard's Settings tab and stored encrypted at rest like the Gemini key. The public report gained a **Deeper analysis — Coming soon** section: five inert placeholder cards naming the judgment checks a rules engine cannot do, quoting no price and promising no date. Public pages and public reports now carry a "Contrast is a Vimoksh project" line.
**Caught.** Our own axe run failed the new cards: `opacity:.75` on the container dragged the body text to **3.24:1**, under the 4.5:1 floor. Fixed by dropping the opacity and letting the dashed border carry the inert reading. Also verified the gating empirically — an admin-path report contains no coming-soon markup, no ghost cards, no support ask and no colophon, exactly as a client deliverable should.
**Decision.** #24 (placeholders name no price and no date).

### 2026-09-10 — AI budget ledger, provider router, OpenAI client
**Shipped.** `src/ai/budget.js` (two-bucket money ledger: an operator monthly ceiling and per-payment credits, with a pre-flight `reserve()` and a `settle()` that records the provider's real usage), `src/ai/openai.js` (Responses API over built-in `fetch`, no SDK; strict JSON-schema translation; reuses `limiter.js` and `ai_cache`), and `src/ai/provider.js` (routes paid→OpenAI, free→Gemini, neither→deterministic-only). New `ai_spend` and `credits` tables. 32 new tests, 152/152 passing.
**Caught.** Verifying model IDs at source — a gate the plan itself set — found the planned `gpt-5.4`/`gpt-5.4-mini` do not exist; the current line is `gpt-5.6-sol`/`terra`/`luna` at materially different prices. Writing the router's tests then exposed a real bug in it: the budget estimate sat *outside* the try block, so an unpriced model threw instead of degrading, in direct violation of #18. Also a test-harness bug where a synchronous `finally` closed the database before the async assertion finished.
**Decision.** #22 (fetch over SDK), #23 (usage read, never estimated). Commercial correction recorded privately as B8.

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
| No TLS on the public scanner | 2026-09-04 | Bare IP, no domain yet — blocked on buying `vimoksh.com` |
| DNS rebinding is narrowed, not eliminated | 2026-09-10 | Every request re-resolves, but a TOCTOU window remains between our resolve and Chrome's connect. Closing it fully needs IP pinning at the socket, which Puppeteer makes awkward |
| `src/graph/` nodes are still untested | 2026-09-10 | The routing is now covered; the nodes themselves need a real browser + real key, so they remain exercised only by manual runs |

**Closed 2026-09-10:** `looksBlocked()` 200-status failover detection · SSRF redirect/subresource re-checking · `src/graph/` routing coverage.

Commercial open items are tracked in `docs/private/DIRECTION.md`.

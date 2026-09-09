# Contrast — Decision Log

**What this doc owns:** why the system is the way it is, and what would legitimately change it.
**Update it when:** you make a call that a future reader could reasonably second-guess. Add a new entry; never edit an old one — mark it `SUPERSEDED BY #n` instead. That history is the point.

Each entry: **Decision → Why → What would change this.** If you find yourself re-arguing something here, read the "what would change this" line first; if none of it has happened, the decision stands.

---

## Product integrity

### #1 — Contrast is a risk report, never a compliance claim · 2026-08-14
**Decision.** Never emit the word "compliant". Every finding is either MEASURED (a rules engine proved it) or AI-ASSESSED (a judgment call needing human confirmation), and reports say absence of findings is not evidence of accessibility.
**Why.** Automated tooling detects roughly 30–40% of WCAG issues. Claiming conformance from that is the overlay industry's mistake and is what regulators reject.
**What would change this.** Nothing short of a human auditor signing each report — at which point the claim is theirs, not the tool's.

> **Numbering has gaps on purpose.** Commercial decisions — who this is sold to, how it is
> priced, which markets, which vendor and why, and what is coming next — live in
> `docs/private/DIRECTION.md`, which is gitignored because this repo is public. Absent
> numbers here are not missing; they are elsewhere.

## AI

### #5 — AI reads the knowledge base, never the findings · 2026-08-14
**Decision.** RAG retrieves from `knowledge/` only. Findings are never embedded or retrieved.
**Why.** Retrieving over findings lets the model reinforce its own earlier guesses. Grounding must come from WCAG/ARIA source material.
**What would change this.** Nothing. This is a correctness property.

### #6 — Report the true automated coverage, even when it's unflattering · 2026-09-04
**Decision.** Reports state that 23 of 86 catalogued criteria (27%) have an automated rule that actually runs, and separate "a rule ran and found nothing" from "no rule can cover this".
**Why.** The ACT harness caught us counting axe's experimental, deprecated and AAA-only rules — rules that never execute. Coverage dropped from a claimed 34% to a true 27%. A tool that overstates its own reach cannot credibly sell honesty as a differentiator.
**What would change this.** New rules actually running — re-measure, don't re-estimate.

### #18 — Degrade, never go dark · 2026-09-09
**Decision.** When AI capacity is unavailable for any reason, fall back to deterministic-only scanning and mark the report accordingly, rather than refusing to scan.
**Why.** axe + a11y tree + keyboard trace need no API at all and already constitute a real report — that is exactly what the free scanner ships today. A tool that sometimes refuses teaches visitors it is unreliable; a tool that says what it did and did not check stays trustworthy.
**What would change this.** Nothing. This follows directly from #1 — a report is honest about its own coverage or it is not worth issuing.

### #21 — The AI provider sits behind a router, never called directly · 2026-09-09
**Decision.** Pipeline code asks a router for an assessment; it never names a vendor. Provider selection, rate limiting, cost caps and caching stay in one place (`src/ai/`), and `ai_cache` keys on content, not vendor.
**Why.** The vendor choice has already changed once. Code that names a provider at the call site turns the next change into a refactor instead of a config edit.
**What would change this.** Nothing.

---

## Architecture

### #7 — SQLite via `node:sqlite`, no ORM, and Postgres stays unused · 2026-08-14, reaffirmed 2026-09-09
**Decision.** One SQLite file per context, `node:sqlite`, hand-written queries. The Postgres already installed on the VPS stays unused.
**Why.** No native build, no dependency, one file is one backup. WAL handles this write volume well past 50 customers.
**What would change this.** Concurrent writers across processes, or multi-machine access.

### #8 — The public scanner is a separate service with no secrets · 2026-09-04
**Decision.** It never mounts `config.json`, `sessions/`, or `auth/`, and never calls Gemini.
**Why.** It is the only service strangers can reach, and it renders URLs they supply. It cannot leak what it cannot read.
**What would change this.** Nothing. If the free tier ever needs AI, it gets its own key with its own cap — never the admin's.

### #9 — The SSRF guard must block CGNAT `100.64.0.0/10` · 2026-09-04
**Decision.** Loopback, RFC1918, link-local **and CGNAT** are refused.
**Why.** `100.64.0.0/10` is Tailscale's own range. Without that specific check, a visitor could paste this deployment's tailnet address and have the public scanner reach the private admin dashboard.
**What would change this.** Nothing. Known remaining gap: initial-resolution only, not full DNS-rebinding protection.

### #10 — Tailscale Serve, not Basic Auth over HTTP · 2026-09-04
**Decision.** The admin dashboard keeps its `127.0.0.1` bind and is bridged to the tailnet with Tailscale's own certificate.
**Why.** Basic Auth over plain HTTP sends credentials in the clear. There is no domain or public certificate.
**What would change this.** A real domain and certificate — and even then the loopback bind stays.

### #11 — Password login is a second lock, not enforced until set · 2026-09-08
**Decision.** Both private panels gate on a scrypt-hashed password, but the gate is inert until `set-password` has been run.
**Why.** Tailnet membership alone treats every device on the network as the operator. But gating an unconfigured install would lock the operator out of the only UI that could let them in.
**What would change this.** Nothing. A damaged auth file also falls open — loudly logged, never silent.

### #12 — Funnel monitoring is its own service · 2026-09-08
**Decision.** A third process, not a tab on the dashboard.
**Why.** Monitoring the free funnel's usage is a different job from auditing a client's site; conflating them put analytics for one product inside the workspace for another.
**What would change this.** Nothing.

### #13 — `config.json` is per-install state, not source · 2026-09-09
**Decision.** Gitignored, seeded from `config.example.json` by `loadConfig()`.
**Why.** A client list only means something next to the `runs/` database holding those clients' audits — and `runs/` is gitignored. Committing it meant the VPS inherited a dev machine's 22 clients with zero runs each.
**What would change this.** Nothing.

### #19 — Shared report cache holds public URLs only · 2026-09-09
**Decision.** Only anonymous scans of publicly reachable pages may be served to another user. Snippet-captured pages, post-login pages, and watchdog customer sites are permanently excluded.
**Why.** Findings on a public page are facts any visitor could observe. Findings behind a login, or on a paying customer's site, are not ours to redistribute.
**What would change this.** Explicit customer consent, per site, in writing.

---

## Verification practice

### #20 — Verify empirically; do not reason and call it done · standing
**Decision.** Claims about behaviour get checked by running the thing: a real browser, a real request, a real database read.
**Why.** This practice has caught, among others: a rate limiter that burned quota on typos; a runId mismatch that 404'd every report; an image tag a full major version behind the lockfile; an `ENV` after `RUN` that silently no-op'd; a funnel chart reporting "490% continued"; and three accessibility violations in our own monitoring panel.
**What would change this.** Nothing. It is the reason the above are past tense.

# Contrast — Architecture

**What this doc owns:** what exists, how it is wired, and where the trust boundaries are.
**Update it when:** a service, port, data store, or boundary changes. Not for behaviour — that's `DATA-FLOW.md`. Not for reasoning — that's `DECISIONS.md`.

Companion docs: [`DATA-FLOW.md`](DATA-FLOW.md) (how data moves) · [`DECISIONS.md`](DECISIONS.md) (why it's like this) · [`TIMELINE.md`](TIMELINE.md) (when it changed) · [`../DESIGN.md`](../DESIGN.md) (visual system) · [`../DEPLOY.md`](../DEPLOY.md) (runbook).

---

## 1. Services

Four processes. Three are long-running servers; the fourth is spawned per job.

| # | Service | Entry | Port | Bind | Reached via | Public? |
|---|---|---|---|---|---|---|
| 1 | **Admin dashboard** | `src/ui/server.js` | 4321 | `127.0.0.1` | Tailscale Serve :443 | No |
| 2 | **Public scanner** | `src/public/server.js` | 8080 | `0.0.0.0` | Bare IP (domain pending) | **Yes** |
| 3 | **Funnel monitoring** | `src/funnel/server.js` | 4322 | `127.0.0.1` | Tailscale Serve :4322 | No |
| 4 | **CLI / job runner** | `src/cli.js` | — | — | Spawned by (1), or by hand | No |

All three servers run from the same image (`contrast:latest`) with `network_mode: host`, differing only in `command:` and which volumes they mount. Host networking is required so "the container's `127.0.0.1`" and "the VPS's `127.0.0.1`" are the same address, which is what `tailscale serve` needs.

### Why three servers and not one

Each boundary is a blast-radius decision, not an organisational one:

- **(2) never mounts `config.json`, `sessions/`, or `auth/`.** It is the only service reachable by strangers, and it renders URLs they supply. It cannot leak the Gemini key, the client list, or the operator password because it cannot read them.
- **(3) is separate from (1)** because monitoring the free funnel's usage is a different job from auditing a client's site. It mounts `runs/` and `auth/` only — no `config.json`, no `sessions/`.
- **(4) is a subprocess** so a crashing scan cannot take the dashboard down with it.

---

## 2. The 7-phase pipeline

Phases 1–6 are plain functions, callable independently from the CLI. Phase 7 is the only place they are wired into a cyclic graph.

| Phase | Module | Does |
|---|---|---|
| 1. Crawl | `src/browser/` | Manual login + encrypted session reuse, read-only request guard, robots-aware BFS |
| 2. Scan | `src/scan/` | axe-core, Chrome a11y tree, keyboard trace, screenshots, inventory |
| 3. Normalize | `src/scan/normalize.js` | Tool output → `Finding[]`; dedupes axe/Lighthouse by selector+criterion |
| 4. AI-assess | `src/ai/` | Gemini judgment tasks; RAG over `knowledge/` only, never over findings |
| 5. Fix + verify | `src/ai/remediate.js`, `src/verify/` | Generate fix, inject into a fresh page, re-scan, confirm resolved + no regressions |
| 6. Report | `src/report/` | JSON, printable HTML, run-to-run diff, VPAT/ACR draft |
| 7. Orchestration | `src/graph/` | LangGraph state graph over 1–6; SQLite checkpointing; `interrupt()` for manual login and fix escalation |

**Supporting modules:** `src/db.js` (schema + all queries), `src/config.js` (client/group tree), `src/secrets.js` (encrypted key store), `src/auth.js` (operator login), `src/timeout.js`.

---

## 3. Data stores

| Path | Contains | Read by | Git |
|---|---|---|---|
| `runs/audit.sqlite` | Admin's own audits | (1), (4) | ignored |
| `runs/public.sqlite` | Free-scanner runs + funnel analytics tables | (2), (3) | ignored |
| `runs/<runId>/` | Screenshots, `report.html`, `report.json` | (1), (2), (3) | ignored |
| `sessions/.secrets.json` | Gemini API key — AES-256-GCM | (1), (4) | ignored |
| `sessions/.key` | Vault key for the above (0600) | (1), (4) | ignored |
| `auth/.auth.json` | Operator password: scrypt hash, then AES-256-GCM | (1), (3) | ignored |
| `auth/.key` | Vault key for the above (0600) | (1), (3) | ignored |
| `config.json` | Clients, groups, scan/AI settings | (1), (4) | **ignored** — seeded from `config.example.json` |
| `knowledge/` | WCAG/ARIA/house-pattern corpus for RAG | (1), (2), (4) | tracked |

**One schema, many files.** `openDb(path)` applies the same schema to whichever SQLite file it is given, so `audit.sqlite` and `public.sqlite` share table definitions. Tables that only make sense in one context (`ai_cache`, `crawl_rules`) simply sit empty in the other.

**`runs/<runId>/` is a shared folder namespace.** Both (1) and (2) write into it — `runDir()` is hardcoded to `runs/`. They are separated by *database ownership*, not by directory: the static-file route checks the runId exists in its **own** database before serving anything, so an admin runId 404s on the public server even though the file is right there on disk. This was verified empirically, not assumed.

---

## 4. Trust boundaries

Ordered by what an attacker would try first.

| Boundary | Mechanism | Where |
|---|---|---|
| **Stranger → your VPS's private network** | SSRF guard resolves the hostname and refuses loopback, RFC1918, link-local, and **CGNAT `100.64.0.0/10` — Tailscale's own range**, so a pasted tailnet address cannot reach the admin dashboard | `src/public/ssrf.js` |
| **Stranger → another user's run** | Static route checks runId against the serving process's own DB before reading disk | `src/public/server.js` |
| **Stranger → your VPS's resources** | Per-IP rate limit (3/hr), global concurrency gate (2), page cap (5) | `src/public/ipLimiter.js` |
| **Internet → admin dashboard** | `127.0.0.1` bind + Tailscale Serve; no port 80/443 exposure | `src/ui/server.js` |
| **Tailnet device → admin dashboard** | Password (scrypt + HMAC-signed `HttpOnly`/`SameSite=Strict` cookie). **Not enforced until a password is set** — an unconfigured install must not lock its operator out | `src/auth.js` |
| **A page you visit → your dashboard** | CSRF fence: custom `x-a11y-ui` header (a cross-origin form cannot set it) + Origin check on every mutating route | `csrfProblem()` in `src/ui/server.js` |
| **Injected input → a shell** | Fixed command allowlist, positional args, never string interpolation | `src/ui/jobs.js` |
| **Scanned page → the host** | Chrome's own sandbox, enabled via `cap_add: SYS_ADMIN` rather than disabled via `--no-sandbox` | `docker-compose.yml` |
| **Client credentials → disk** | Never stored. Browser sessions are AES-256-GCM sealed; the Gemini key never enters `config.json` | `src/browser/session.js`, `src/secrets.js` |

**`--no-sandbox` appears only in test files.** The services that render attacker-supplied URLs use `SYS_ADMIN` so Chrome's renderer sandbox stays on — it is the containment boundary, not a nicety.

---

## 5. Runtime & dependencies

- **Node 22+, ESM, no build step, no framework, no ORM.** Frontends are vanilla ES modules + CSS.
- **SQLite via `node:sqlite`** — no native build, no dependency.
- **Dependencies:** `puppeteer`, `axe-core`, `@axe-core/puppeteer`, `lighthouse` (off by default), `@google/generative-ai`, `@langchain/langgraph` (+ sqlite checkpointer), `geoip-lite`.
- **Base image** `ghcr.io/puppeteer/puppeteer:25.10.0`, pinned to the **lockfile's** puppeteer version, not `package.json`'s caret range.
- **Tests:** `node --test`, 120 tests, no test framework. `npm run audit:ui` runs axe against Contrast's own UI — zero violations is a build condition.

---

## 6. Planned, not built

Everything above exists today. Planned work is commercial and lives in
`docs/private/DIRECTION.md` (gitignored — this repo is public). Move an item into this
document only once it ships.

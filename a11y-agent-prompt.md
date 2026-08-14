# Claude Code Prompt — AI Accessibility Audit Agent

Paste everything below into Claude Code as your initial prompt.

---

## Project

Build an AI-assisted web accessibility auditing tool that scans websites (including authenticated/logged-in pages), detects WCAG 2.1/2.2 violations, and generates verified remediation code.

This is a **capacity multiplier for a team of manual accessibility auditors** — it handles machine-detectable and machine-assessable issues so human auditors spend their time on judgment calls only humans can make. Design accordingly: completeness and auditability matter more than cleverness.

## Stack

- **Runtime:** Node.js (backend orchestration, Puppeteer)
- **Scanning:** Puppeteer, `@axe-core/puppeteer`, Lighthouse (programmatic API)
- **AI layer:** Google Gemini API (`@google/generative-ai`) — Flash / Flash-Lite tier
- **Storage:** SQLite for scan results (single-file, portable, no infra)
- **Vector store:** local embeddings store for the WCAG knowledge base only
- **Frontend:** minimal — a simple report viewer, not a product UI. Do not spend time on design.

Do not add frameworks, ORMs, or abstractions I did not ask for.

## Architecture — build in this order

### Phase 1: Browser + session layer

Build `src/browser/`:

- Launch Puppeteer in **headed mode** for an interactive login flow: auditor logs in manually (handles SSO, OTP, captcha), then presses Enter in the CLI to signal ready.
- Persist cookies + localStorage + sessionStorage to `sessions/<client>.json`. Reuse on subsequent scans; detect expiry and prompt re-login.
- **Read-only guard (critical):** intercept requests and block all non-GET methods by default. When crawling an authenticated app, the agent must never submit forms, trigger deletes, or hit logout. Maintain a URL denylist (`/logout`, `/delete`, `/signout`) plus a configurable allowlist for crawl scope.
- Crawler: BFS from a seed URL, same-origin only, configurable max depth and max pages, respects the allowlist.

### Phase 2: Scan + normalize

Build `src/scan/`:

For each page, collect:
- Axe-core results (violations, incomplete, passes)
- Lighthouse accessibility category results
- `page.accessibility.snapshot()` — the Chrome accessibility tree
- Full-page screenshot + per-element bounding-box screenshots for flagged elements
- Computed styles for flagged elements (real contrast values, not declared CSS)
- Programmatic keyboard-navigation trace: fire Tab repeatedly, record actual focus order, compare against DOM order, flag mismatches

Normalize everything into a single schema. Axe and Lighthouse overlap heavily — **deduplicate** by (DOM selector + WCAG criterion).

```
Finding {
  id, pageUrl, timestamp,
  source: 'axe' | 'lighthouse' | 'a11y-tree' | 'keyboard' | 'ai',
  wcagCriterion,        // e.g. "1.1.1"
  wcagLevel,            // A | AA | AAA
  severity,             // critical | serious | moderate | minor
  ruleId,
  domSelector,
  htmlSnippet,
  computedStyles,       // only the properties relevant to the rule
  screenshotPath,
  description,
  confidence            // 1.0 for deterministic, <1.0 for AI-assessed
}
```

Persist to SQLite. Every scan run gets a run ID so results are diffable across runs.

### Phase 3: AI assessment layer (Gemini)

Build `src/ai/`.

**Do NOT use RAG over the scan findings.** They are structured and complete — filter them deterministically by page, component, selector, severity, or WCAG level. Vector search over structured findings risks missing items, which is unacceptable in a compliance tool.

**DO use RAG over the knowledge base:** WCAG 2.1/2.2 success criteria and Understanding docs, ARIA Authoring Practices patterns, and a folder of house remediation examples (`knowledge/house-patterns/`). Retrieve the relevant criterion + closest past fix and inject as grounding context for every generation.

AI tasks (each a separate, testable module):
1. **Alt-text quality** — vision call: is existing alt text meaningful for this image in this context? (Machines already catch *missing* alt; the gap is *bad* alt.)
2. **Link/button text quality** — flag "click here", "read more", non-descriptive labels
3. **Heading hierarchy semantics** — does the structure make logical sense, not just "headings exist"
4. **Form label + error message quality**
5. **Reading order** — CSS-positioned content that reads wrong to a screen reader
6. **Remediation generation** — output corrected HTML/ARIA/CSS

### Phase 4: Gemini rate-limit discipline (do this properly, not as an afterthought)

Free tier is roughly 15 RPM and ~1,000-1,500 requests/day on Flash/Flash-Lite; 2.5 Pro is effectively trial-only. Build a request manager:

- **Sequential queue** with a token-bucket limiter. Never `Promise.all` API calls.
- **Exponential backoff with jitter** on 429. Never immediate retry.
- **Batch aggressively** — one call assessing 20 images beats 20 calls. Group by component.
- **Content-hash cache** — never re-analyze an unchanged element across runs.
- **Structured output** — use JSON mode, validate every response against a schema, retry on malformed output.
- Make model name, RPM, and daily cap config values, not constants. These limits change.

### Phase 5: Fix verification loop (the differentiator — do not skip)

After generating a remediation:
1. Inject the fixed HTML into the page in a fresh browser context
2. Re-run Axe on the patched DOM
3. Confirm the original violation is resolved **and no new violations were introduced**
4. Mark each fix `verified` / `unverified` / `regressed` in the report

A fix that isn't verified is a suggestion, not a fix. Label it that way.

### Phase 6: Reporting

- JSON report (machine-readable, full detail)
- HTML report: grouped by page → component → severity, with screenshots, WCAG criterion links, before/after code, and verification status
- **Diff mode:** compare two run IDs, show fixed / new / still-broken. This is what makes re-audits fast.
- VPAT/ACR first-draft generator from findings (human edits it — do not claim it is final)

### Phase 7: Agent orchestration with LangGraph.js

Once Phases 1-6 work as plain functions, refactor the *orchestration* into a LangGraph.js state graph. Do not do this earlier — get deterministic code working first, then wrap it.

**Packages:** `@langchain/langgraph`, `@langchain/core`, `@langchain/google-genai` (for `ChatGoogleGenerativeAI`), `zod` for schemas.

**Use LangGraph for what it is actually good at here:** the fix-generate → verify → retry loop is a cyclic graph with state, and that is exactly what LangGraph models well and what plain async code models badly.

**Do NOT wrap Puppeteer, Axe, or Lighthouse in LangChain tool abstractions.** Those are deterministic functions with no reasoning involved. Call them directly. Adding chains around them buys nothing and hides errors.

**Graph state:**

```
AuditState {
  runId, clientId,
  pagesQueued: string[],
  pagesScanned: string[],
  findings: Finding[],
  currentComponent: ComponentGroup | null,
  proposedFix: Fix | null,
  verificationResult: 'verified' | 'regressed' | 'unresolved' | null,
  fixAttempts: number,
  completedFixes: Fix[],
  abandonedFindings: Finding[],
  errors: Error[]
}
```

Use `Annotation.Root` with explicit reducers — `findings` and `completedFixes` append, scalars replace. Do not rely on default merge behaviour.

**Nodes:**

- `crawl` — discover pages within scope
- `scanPage` — Axe + Lighthouse + a11y tree + keyboard trace + screenshots (deterministic, Phase 2)
- `normalize` — dedupe and map into the Finding schema
- `groupComponents` — deterministic filter/chunk by page → component. **Not** a retrieval step.
- `assessWithAI` — the Gemini judgment tasks (alt-text quality, link text, heading semantics, reading order)
- `retrieveGuidance` — RAG over WCAG/ARIA/house-patterns only, to ground the fix
- `generateFix` — Gemini produces remediated HTML/ARIA/CSS
- `verifyFix` — re-inject, re-scan, check resolved + no regressions (Phase 5)
- `escalateToHuman` — write to a review queue with full context
- `report` — assemble outputs

**Edges — the important part:**

- `scanPage` → conditional: more pages queued? loop back : continue
- `verifyFix` → conditional:
  - `verified` → append to `completedFixes`, move to next component
  - `regressed` or `unresolved` and `fixAttempts < 3` → back to `generateFix` with the failure reason added to state (this is the cycle LangGraph exists for)
  - `fixAttempts >= 3` → `escalateToHuman`, never loop forever
- Any AI node erroring → escalate rather than silently dropping the finding

**Why LangGraph specifically here:**

- **Checkpointing** — use `SqliteSaver`. A 500-page authenticated audit will hit rate limits, session expiry, or a crash. Being able to resume from the last checkpoint instead of re-scanning from zero is worth the dependency on its own.
- **Interrupts** — use `interrupt()` before the manual-login step and before escalating a fix to human review. The auditor becomes a node in the graph, not an out-of-band process.
- **Traceability** — each node transition is inspectable. For a compliance tool, being able to show *why* a fix was proposed is a real requirement, not a nicety.

**Keep the rate limiter outside the graph.** It is a global concern across all Gemini nodes; a shared queue module every AI node calls, not per-node logic.

**Honest note on LangChain (the non-graph parts):** use `ChatGoogleGenerativeAI` with `withStructuredOutput(zodSchema)` for typed responses, and its text splitters and vector store for the WCAG knowledge base. Skip the rest — agents, generic chains, memory abstractions. This pipeline is mostly deterministic with AI at specific points, not an open-ended agent, and forcing it into agent abstractions will make it slower and harder to debug.

## Non-negotiable constraints

- **Never store client credentials.** Manual-login-then-persist-session only.
- **Never bypass authentication, captchas, or bot protection.** Sessions come from a human logging in with client-provided access.
- **Free Gemini tier is for development only.** Google may use free-tier prompts for training. Make the tier a config flag and document loudly that client data requires a paid tier.
- **Deterministic findings and AI findings must be visually distinct in reports.** Auditors need to know what is certain vs. assessed.
- **Never claim full WCAG conformance.** Automated tools catch roughly 30-40% of issues. The report must state its own limits.

## Working style

- Build phase by phase. Working code at each phase before moving on. Phases 1-6 as plain functions first; only then refactor orchestration into the LangGraph state graph in Phase 7.
- Tests for the normalizer, deduplication, and rate limiter — those are where silent bugs hide.
- Real config file, no hardcoded values.
- Ask me before adding any dependency not listed above.

Start with Phase 1. Show me the project structure first, then implement.

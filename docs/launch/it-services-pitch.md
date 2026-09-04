# Contrast for IT services companies
### Turn a contractual accessibility line item into a two-minute check, not a two-week scramble.

---

## The problem you're already carrying

If your contracts touch government, education, healthcare, or a large
enterprise client, there's a real chance one of them already has a WCAG 2.1
AA clause buried in the SOW — or will soon. The European Accessibility Act
started enforcement in June 2025. US state and local government sites are on
ADA Title II compliance deadlines. Procurement teams increasingly ask for a
VPAT/ACR before they'll even sign.

The usual response is one of three bad options:
- **A generic scanner report**, dumped on the client with no distinction
  between what's actually broken and what the tool merely flagged — which
  either overwhelms them or, worse, gets waved off as noise until the real
  issue surfaces in production.
- **A full manual audit**, which is the right answer and also the expensive,
  slow one — not something you can run on every sprint, every client.
- **Nothing**, until a client's own compliance team or an end user finds it
  first.

## What Contrast actually does differently

It doesn't try to replace the manual audit — it clears the measurable ground
first so your auditors spend their hours on the judgment calls only a human
can make.

- **Measured, not guessed.** axe-core, the Chrome accessibility tree, and a
  real keyboard-navigation trace — deterministic checks with a WCAG citation
  attached to every one.
- **AI flags what machines miss, never claims certainty it doesn't have.**
  Alt-text that's technically present but useless, link text that says
  nothing out of context, heading structure that doesn't match the page —
  each judgment call is labelled as exactly that, confidence score included.
- **Fixes are proven, not proposed.** Every generated fix is injected into a
  fresh page and re-scanned. Resolved and nothing new broken, or it's a
  suggestion your team reviews — never a silent claim.
- **The compliance paperwork writes its own first draft.** A VPAT/ACR draft
  generated straight from the findings, with every "Not Evaluated" row
  honestly marked as needing a human, not padded into a false "Supports."

## What this looks like on a real engagement

We ran Contrast's free deterministic scan against homepages of 8 major
companies with no special access — no accounts, no login. It found a real
WCAG 2.2.1 timing violation on one of India's largest banks (a forced
5-second redirect with no way to pause it) and a required form field with no
accessible name at all on a leading fintech checkout page. Both are the kind
of finding that's cheap to catch in a code review and expensive to defend
in a complaint. [See the full writeups → /audits/summary]

## What you'd actually use it for

- A fast, repeatable baseline check on every client site before a release,
  not just once a year
- A first-pass triage before your accessibility auditor's billable hours
  start, so they open a project already knowing what's measured vs. what
  needs their judgment
- A VPAT/ACR first draft you edit and sign, instead of one you write from a
  blank page

## Try it before you talk to us

The deterministic scanner is free, no account: **[your-domain]/scan**. Paste
a client site's homepage and see exactly what it finds in about a minute.

Questions, or want the full AI-assisted pipeline (fix generation + verified
re-testing) on a real engagement? Reply to this and we'll set it up.

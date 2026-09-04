# Accessibility scan: State Bank of India

**Site**: sbi.co.in · **Pages scanned**: 1 · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace. **Note on scope**: `sbi.co.in` redirects every visitor through an
interim page at `/redirect/` before landing on `sbi.bank.in` (India's RBI-mandated `.bank.in`
domain for regulated banks) — this scan measured that redirect page itself, which every real
visitor passes through, not the final banking portal.

## What we found

**9 findings**, the most notable of which is a genuine timing problem baked into the page's own
design, not an edge case a scanner invented:

### A forced page refresh with no way to pause, extend, or disable it (critical, WCAG 2.2.1, Level A)
```html
<meta http-equiv="refresh" content="5; url=https://sbi.bank.in/">
```
The page redirects itself after exactly 5 seconds with no user control at all. WCAG 2.2.1
exists specifically for this: anyone who reads more slowly, uses a screen magnifier, or simply
takes a moment to read "Important Information" (the page's actual `<h1>`) before it vanishes
gets no chance to. Five seconds is also well under typical screen-reader announcement time for
a page like this.

### An ARIA attribute used on an element that doesn't support it (serious, WCAG 4.1.2, Level A)
```html
<div class="spinner" aria-label="Loading"></div>
```
`aria-label` on a plain, non-interactive, non-landmark `<div>` isn't guaranteed to be exposed to
assistive technology the way the page's authors likely intended.

### No `<main>` landmark (moderate, WCAG 1.3.1, Level A)
Confirmed via the Chrome accessibility tree — there's no way to skip straight to the page's
content.

### Text contrast flagged for human review (moderate, WCAG 1.4.3, Level AA)
Including the page's own `<h1>Important Information</h1>` — axe couldn't fully resolve the
rendered contrast automatically and flagged it for a person to confirm.

## What this doesn't cover
This is one interim page, not SBI's real banking portal or net-banking flows, which sit behind
a login this tool never attempts to bypass. The forced-refresh finding above is real and
specific to this exact page regardless.

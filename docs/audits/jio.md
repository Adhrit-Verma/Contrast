# Accessibility scan: Jio

**Site**: jio.com · **Pages scanned**: 1 (homepage) · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace — deterministic, machine-provable checks only, no AI-assessed judgment
calls in this pass. Automated tools catch roughly 30–40% of WCAG issues; what follows is a set of
confirmed, measured facts, not a full audit or a claim of conformance.

## What we found

**28 findings** on the homepage alone. The most notable:

### A carousel slide is hidden from screen readers but still reachable by keyboard (serious, WCAG 4.1.2, Level A)
```html
<div class="embla__slide ... embla__slide__loop css-1cfjzea" role="group"
     aria-roledescription="slide" aria-label="Slide 3 of 3" aria-hidden="true">
```
`aria-hidden="true"` tells assistive technology this content doesn't exist, but its interactive
contents are still in the tab order — a screen reader user can tab into a slide their screen
reader insists isn't there.

### Keyboard focus with no visible indicator on the logo link (serious, WCAG 2.4.7, Level AA)
```html
<a href="/" class="j-link" aria-label="Jio header logo" tabindex="0">
```
The very first tab stop on the page — the header logo — gives no visual sign it has focus.

### A landmark region reused without a distinguishing label (moderate)
Two navigation regions share the id `firstlevel-nav`-style structure with no way for assistive
technology to tell them apart by name.

### An ARIA role used where it doesn't belong (minor)
```html
<a href="https://www.jio.com/help/home#/" tabindex="-1" role="listitem">
```
A link marked `role="listitem"` outside of a `role="list"` container confuses how assistive
technology announces it.

### Text contrast — 15 elements flagged for human confirmation, 1 confirmed failing (WCAG 1.4.3, Level AA)
Contrast measurement against a background image or gradient can't always be fully automated;
these are flagged as needing a person to look, not asserted as definite failures.

## What this doesn't cover
Jio's mobile plan comparison tools and account sign-in flow weren't scanned. This pass also
skipped the AI-assessed checks (alt-text quality, link/heading semantics) — only what a machine
can prove outright.

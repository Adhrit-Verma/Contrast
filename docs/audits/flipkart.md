# Accessibility scan: Flipkart

**Site**: flipkart.com · **Pages scanned**: 4 · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace — deterministic, machine-provable checks only, no AI-assessed judgment
calls in this pass. Automated tools catch roughly 30–40% of WCAG issues; what follows is a set of
confirmed, measured facts, not a full audit or a claim of conformance.

## What we found

**122 findings** across the homepage, the login page, and the flights section. The most
frequent and most serious:

### Images with no alternative text — 14 instances (critical, WCAG 1.1.1, Level A)
The homepage's own navigation icons ship with no `alt` at all:
```html
<img src="https://static-assets-web.flixcart.com/apex-static/images/svgs/L1Nav/all.svg" loading="lazy" style="width:36px;height:36px">
```
A screen reader announces this as nothing — not even "image" — so a blind shopper loses the
navigation icon entirely.

### Text contrast below the AA threshold — 24 confirmed, 9 more flagged for human review (serious, WCAG 1.4.3, Level AA)
```html
<label class="QQ7PNk">Enter Email/Mobile number</label>
```
The label on Flipkart's own login field is one of the elements failing the 4.5:1 minimum
contrast ratio required for body text.

### Keyboard focus with no visible indicator — 4 instances (serious, WCAG 2.4.7, Level AA)
The search submit button in the header receives keyboard focus with neither an outline nor a
box-shadow:
```html
<button class="XFwMiH" type="submit" aria-label="Search for Products, Brands and More">
```
A sighted keyboard-only user tabbing through the page cannot see where focus currently is.

### Content not contained in a landmark region — 29 instances (moderate)
Large parts of the layout, including a sticky sidebar element, sit outside any semantic
landmark (`<main>`, `<nav>`, `<aside>`), which makes them harder for screen reader users to
navigate to directly.

### No `<main>` landmark on the page (moderate, WCAG 1.3.1, Level A)
Confirmed independently via the Chrome accessibility tree, not just axe — there is no way for a
screen reader user to jump straight to the page's primary content.

## What this doesn't cover
This pass didn't include Flipkart's checkout or payment flow (both require an account), and it
didn't run the AI-assessed checks (alt-text *quality*, link text, heading structure) — only
what a machine can prove outright. A full audit would need both, plus manual screen-reader and
keyboard testing.

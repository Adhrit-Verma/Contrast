# Accessibility scan: Domino's India

**Site**: dominos.co.in · **Pages scanned**: 1 (homepage) · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace. Automated tools catch roughly 30–40% of WCAG issues; what follows is
a set of confirmed, measured facts, not a full audit or a claim of conformance.

## What we found

**15 findings** — the smallest count in this series, but the primary call-to-action itself is
one of them.

### The main "Order Online" button fails text contrast (serious, WCAG 1.4.3, Level AA)
```html
<a class="brand-home__hero-cta">ORDER ONLINE NOW</a>
```
The single most important action on the homepage — the button that starts an order — doesn't
clear the minimum 4.5:1 contrast ratio for its text.

### Logo image has no alternative text (critical, WCAG 1.1.1, Level A)
```html
<img class="brand-header__logo-img" src="/brand-jfl-discovery-ui/public/dist/Logo.png">
```
A screen reader announces the header logo as nothing.

### No `<main>` landmark (moderate, WCAG 1.3.1, Level A)
Confirmed both by axe and independently by the Chrome accessibility tree.

### Social links using `aria-label` in a way that needs human confirmation (moderate, WCAG 4.1.2, Level A)
```html
<a class="brand-footer__social-link" aria-label="Facebook" target="_blank" rel="noopener noreferrer">
  <img src="/brand-jfl-discovery-ui/public/dist/fb.png" alt="Facebook" class="bra...">
```
Flagged for review rather than a confirmed failure — worth a person checking whether the
`aria-label` and the image's own `alt="Facebook"` end up announced together or redundantly.

## What this doesn't cover
The online ordering flow itself (menu, cart, checkout) wasn't scanned — homepage only. The
AI-assessed checks weren't run in this pass.

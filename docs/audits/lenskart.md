# Accessibility scan: Lenskart

**Site**: lenskart.com · **Pages scanned**: 2 unique (homepage, corporate/about) · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace. Automated tools catch roughly 30–40% of WCAG issues; what follows is
a set of confirmed, measured facts, not a full audit or a claim of conformance.

## What we found

**147 findings**, dominated by one specific, repeated markup pattern.

### ARIA attributes used on elements that don't support them — 55 confirmed, 25 more flagged for review (serious/moderate, WCAG 4.1.2, Level A)
```html
<div data-cy="banner-slide-0" aria-label="Featureboard New at Lenskart Banner" data-promoname="" ...>
```
The homepage's promotional banner carousel repeats this pattern across every slide — an
`aria-label` on an element type that doesn't guarantee it's exposed to assistive technology.
This single pattern accounts for over half of all findings on the site.

### Videos with no caption track, flagged for human review — 25 instances (moderate, WCAG 1.2.2, Level A)
```html
<video muted="" playsinline="" poster="" preload="auto" src="blob:https://www.lenskart.com/...">
```
Autoplaying product/promotional videos with no caption track. Automated tools can't confirm
captions are *absent* with full certainty (a track could load dynamically), which is why these
are flagged rather than asserted outright — but 25 instances of the same pattern is a strong
signal worth a person checking directly.

### A link with no destination and no name (serious, WCAG 2.4.4, Level A)
```html
<a href="">
  <video autoplay="" loop="" muted="" id="cherryBlossom" src="blob:...">
</a>
```
On the corporate "About" page, a decorative video is wrapped in a link that goes nowhere
(`href=""`) and announces nothing.

### An empty heading (minor)
```html
<h2 data-cy="plpHeadingTypography-S" class="sc-c720f004-0 dsIpOC"></h2>
```
A heading element with no text content at all — likely a component that failed to receive its
expected data.

## What this doesn't cover
Lenskart's product try-on and checkout flows weren't scanned — homepage and one static page
only. The AI-assessed checks (is the aria-label wording actually meaningful, do headings
describe what follows) weren't run in this pass.

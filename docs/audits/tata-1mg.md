# Accessibility scan: Tata 1mg

**Site**: 1mg.com · **Pages scanned**: 4 · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace. Automated tools catch roughly 30–40% of WCAG issues; what follows is
a set of confirmed, measured facts, not a full audit or a claim of conformance. Given 1mg is a
healthcare platform — medicine ordering, lab tests, doctor consultations — accessibility here
has real stakes beyond convenience.

## What we found

**326 findings** across the homepage, labs, doctor-consultation, and cancer-care pages.

### Carousel control buttons with no accessible name — 3 confirmed, plus 24 interactive nodes flagged by the accessibility tree (critical, WCAG 4.1.2, Level A)
```html
<button class="BannerWidgetCarouselAutoScroll__controlButton__WvrnJ">
  <img src="data:image/svg+xml,...">
</button>
```
A homepage carousel's own navigation buttons carry no name — a screen reader announces "button"
with nothing else, on the controls used to browse featured health content.

### Text contrast — 54 confirmed failures, 165 more flagged for review (serious/moderate, WCAG 1.4.3, Level AA)
```html
<div class="padding-0-8 Header__navigationItemText__ShdZ9">MEDICINES</div>
```
The main navigation label for the "Medicines" section — the platform's core function — is
among the confirmed contrast failures.

### 25 links with no discernible text (serious, WCAG 2.4.4, Level A)
```html
<a class="flex justifyCenter alignCenter" href="/" data-discover="true"></a>
```
The homepage logo link announces nothing to a screen reader user.

### 48 elements outside any landmark region (moderate)
A screen reader user browsing 1mg by region — rather than reading the whole page top to bottom
— cannot reach large sections of the layout directly.

### Zoom capped at 200% instead of the required minimum (minor, but worth flagging for a health platform)
```html
<meta name="viewport" content="initial-scale=1, maximum-scale=2, ...">
```
WCAG 1.4.4 requires text be resizable to 200% without loss of function — a `maximum-scale=2`
cap sits right at that line, leaving no room for a user who needs more.

## What this doesn't cover
Prescription upload, cart, and checkout — all central to a pharmacy platform — weren't scanned,
since they need an account. The AI-assessed checks (does this button's icon-only design need a
clearer label, is the health information's heading structure navigable) weren't run in this
pass, and for a healthcare site those judgment calls matter more than most.

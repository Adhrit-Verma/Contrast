# Accessibility scan: Paytm

**Site**: paytm.com · **Pages scanned**: 4 · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace — deterministic, machine-provable checks only. Automated tools catch
roughly 30–40% of WCAG issues; what follows is a set of confirmed, measured facts, not a full
audit or a claim of conformance.

## What we found

**780 findings** across the homepage and three recharge/bill-payment pages — a site with a lot
of interactive surface area, and a lot of it inaccessible by keyboard specifically.

### An unlabelled required form field (critical, WCAG 4.1.2, Level A)
```html
<input type="text" required="" autocomplete="off" value="">
```
On the DTH recharge page, a required text input carries no accessible name at all — a screen
reader announces it as a plain, anonymous text box with no indication of what it's asking for.

### 82 keyboard stops with no visible focus indicator (serious, WCAG 2.4.7, Level AA)
```html
<input type="radio" id="ow" name="journeyType" class="radio" checked="" value="oneWay" label="One Way" ...>
```
The "One Way" journey-type selector — a real, functional form control — gives no visible sign
it has focus when tabbed to.

### Keyboard focus jumps backwards through the page — 42 instances (serious, WCAG 2.4.3, Level A)
```html
<a href="/" class="_2PVi"><img src="...logo_new.svg" alt="Paytm Logo"></a>
```
On the DTH recharge page, tab order returns to the header logo *after* having already moved
13 elements further into the page — a keyboard user's sense of "where am I" breaks.

### Text contrast — 117 confirmed failures, 427 more flagged for review (serious/moderate, WCAG 1.4.3, Level AA)
```html
<span class="Xtdbd"> From </span>
```
Over half of all findings on this site are contrast-related, concentrated in secondary/helper
text like this "From" label next to a price.

### 66 elements outside any landmark region (moderate)
Including the "Recharges & Bill Payments" section itself — a screen reader user browsing by
region cannot land there directly.

## What this doesn't cover
Paytm's wallet, UPI payment, and login flows all require an account and weren't scanned. The
AI-assessed checks (alt-text quality, link/heading semantics) weren't run in this pass.

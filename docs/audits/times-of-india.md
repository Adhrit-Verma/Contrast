# Accessibility scan: Times of India

**Site**: timesofindia.indiatimes.com · **Pages scanned**: 4 · **Date**: 2026-09-04 · **Tool**: [Contrast](../../README.md)

**Methodology**: scanned with Contrast using axe-core, the Chrome accessibility tree, and a real
keyboard-navigation trace — deterministic, machine-provable checks only. Automated tools catch
roughly 30–40% of WCAG issues; what follows is a set of confirmed, measured facts, not a full
audit or a claim of conformance.

## What we found

**990 findings** — by far the largest count in this series, on a page built from a dense stack
of navigation bars, ad slots, and content widgets. The scale itself is a finding: this many
issues on a national news homepage means a screen reader user has to sit through an enormous
amount of noise before reaching an article.

### 160 keyboard stops land on invisible focus (serious, WCAG 2.4.7, Level AA)
```html
<a href="https://epaper.indiatimes.com/timesepaper/publication-the-times-of-india,city-delhi.cms...">
```
160 separate tab stops — including the link into the e-paper edition — give no visible sign
that they currently have keyboard focus. For a sighted keyboard user this makes the entire
navigation bar effectively unusable without trial and error.

### 48 elements hidden from assistive technology are still keyboard-reachable (serious, WCAG 4.1.2, Level A)
A carousel slide marked `aria-hidden="true"` still holds a focusable link inside it — the same
class of bug found on Jio's homepage, here at a much larger scale (a rotating "slick" carousel
repeated across multiple ad and content widgets).

### 27 images with no alternative text (critical, WCAG 1.1.1, Level A)
Several are third-party ad creatives (`mobileads.indiatimes.com`), which doesn't reduce the
impact on a reader relying on alt text — an ad an editor didn't write is still content a
screen reader user is served with nothing to go on.

### 18 links with no discernible text (serious, WCAG 2.4.4, Level A)
Including the masthead link back to the homepage itself.

### 450 elements outside any landmark region (moderate)
Half the total finding count on this page alone — the "Edition" selector in the header is one
of hundreds of pieces of content a screen reader user can't navigate to as a distinct region.

## What this doesn't cover
This did not scan individual articles, the e-paper, or video content — home and section-front
pages only. The AI-assessed checks (is this specific alt text actually *useful*, does this
headline hierarchy make sense) weren't run in this pass.

# Common house fixes

## Icon-only control has no accessible name (4.1.2, 1.1.1)
Before:
```html
<a href="/cart" class="icon-btn"><i class="fa fa-shopping-cart"></i></a>
```
After:
```html
<a href="/cart" class="icon-btn" aria-label="Shopping cart">
  <i class="fa fa-shopping-cart" aria-hidden="true"></i>
</a>
```
Rule: the interactive element carries the name; the decorative glyph is hidden. Never put the
`aria-label` on the icon.

## Non-descriptive link text (2.4.4)
Before:
```html
<p>Our latest accessibility report is out. <a href="/reports/2025">Read more</a></p>
```
After:
```html
<p>Our latest accessibility report is out. <a href="/reports/2025">Read the 2025 accessibility report</a></p>
```
Rule: rewrite the visible text. Only fall back to `aria-label` when the visible text cannot
change — and then the visible words must still appear inside the label (2.5.3).

## Placeholder used as the label (3.3.2, 4.1.2)
Before:
```html
<input type="email" placeholder="Email address">
```
After:
```html
<label for="email">Email address</label>
<input id="email" type="email" name="email" autocomplete="email" placeholder="you@example.com">
```
Rule: a persistent visible label, plus `autocomplete` (1.3.5). The placeholder becomes an
example, never the label.

## Insufficient text contrast (1.4.3)
Before:
```html
<p class="muted" style="color:#999;background:#fff">Last updated 4 March</p>
```
After:
```html
<p class="muted" style="color:#595959;background:#fff">Last updated 4 March</p>
```
Rule: `#595959` on white is 7.0:1 and passes AA and AAA for body text. Darken the foreground
before touching the background — brand backgrounds usually cannot move.

## Focus indicator removed by a reset (2.4.7, 1.4.11)
Before:
```css
*:focus { outline: none; }
```
After:
```css
*:focus-visible {
  outline: 3px solid #1a5fb4;
  outline-offset: 2px;
}
```
Rule: never ship `outline: none` without a replacement. `:focus-visible` keeps the indicator off
mouse clicks while keeping it for keyboard users.

## Clickable div (2.1.1, 4.1.2)
Before:
```html
<div class="card" onclick="openItem(3)">Open item</div>
```
After:
```html
<button type="button" class="card" onclick="openItem(3)">Open item</button>
```
Rule: a native `<button>` brings role, focusability, Enter/Space and the disabled state for
free. Only fall back to `role="button" tabindex="0"` plus key handlers when the element genuinely
cannot be a button.

## Fake heading (1.3.1, 2.4.6)
Before:
```html
<div class="section-title"><b>Billing details</b></div>
```
After:
```html
<h2 class="section-title">Billing details</h2>
```
Rule: keep the class so the styling survives; change the element so the structure is real.

## Missing skip link and main landmark (2.4.1, 1.3.1)
After:
```html
<a class="skip-link" href="#main">Skip to main content</a>
<header>…</header>
<main id="main" tabindex="-1">…</main>
```
```css
.skip-link { position:absolute; left:-10000px; top:auto; }
.skip-link:focus { left:8px; top:8px; width:auto; height:auto; z-index:1000; padding:8px 12px; background:#fff; }
```
Rule: first focusable element in the document, visible on focus, target is `<main>` with
`tabindex="-1"` so focus actually lands there.

## Image alt that repeats the caption (1.1.1)
Before:
```html
<figure>
  <img src="chart.png" alt="Chart showing quarterly revenue">
  <figcaption>Chart showing quarterly revenue</figcaption>
</figure>
```
After:
```html
<figure>
  <img src="chart.png" alt="Revenue rose from £1.2m in Q1 to £2.1m in Q4 2025">
  <figcaption>Chart showing quarterly revenue</figcaption>
</figure>
```
Rule: the alt carries what the image shows; the caption already says what it is. Duplicating the
caption tells a screen reader user nothing new.

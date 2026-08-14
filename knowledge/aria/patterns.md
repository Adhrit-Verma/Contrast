# ARIA Authoring Practices — pattern summaries

Condensed from the WAI-ARIA Authoring Practices Guide (https://www.w3.org/WAI/ARIA/apg/).
First rule of ARIA: do not use ARIA if a native element does the job.

## Disclosure (show/hide)
Trigger is a `<button aria-expanded="false" aria-controls="panel-id">`. Toggle `aria-expanded`
on activation. The panel is a sibling with `id="panel-id"`; hide with `hidden` or `display:none`
so it leaves the accessibility tree. No `role` needed on the panel.

## Modal dialog
`<dialog>` with `showModal()` is the lazy correct answer — it gives focus trapping, Escape, and
inertness for free. Hand-rolled version: `role="dialog" aria-modal="true"` plus
`aria-labelledby` pointing at the title, focus moved into the dialog on open, focus trapped
while open, Escape closes, focus returned to the trigger on close, and the rest of the page
marked `inert`.

## Accordion
Each header is `<h3><button aria-expanded aria-controls="sect1">…</button></h3>`. Panel is
`<div id="sect1" role="region" aria-labelledby="header-button-id">`. Do not put `role="tab"` on
accordion headers.

## Tabs
`role="tablist"` wraps `role="tab"` buttons; each tab has `aria-selected` and `aria-controls`.
Panels are `role="tabpanel" aria-labelledby="<tab id>" tabindex="0"`. Roving tabindex: the
selected tab has `tabindex="0"`, the rest `-1`; Left/Right arrows move between tabs.

## Combobox / autocomplete
`<input role="combobox" aria-expanded aria-controls="listbox-id" aria-autocomplete="list"
aria-activedescendant="option-id">` with a `role="listbox"` of `role="option"` items. Keep
`aria-activedescendant` in sync; do not move DOM focus into the list.

## Menu button
`<button aria-haspopup="true" aria-expanded="false" aria-controls="menu-id">` opening a
`role="menu"` of `role="menuitem"`. Arrow keys move, Escape closes and returns focus. Do not use
menu roles for site navigation — that is a `<nav>` with a list of links.

## Skip link
First focusable element in the document:
`<a class="skip-link" href="#main">Skip to main content</a>` with CSS that positions it
off-screen until `:focus`, and `<main id="main" tabindex="-1">` as the target.

## Live region
Container exists in the DOM before the message arrives. `role="status"` (polite) for
confirmations and counts, `role="alert"` (assertive) for errors. Do not put `aria-live` on an
element you also insert at the same moment — screen readers will miss it.

## Data table
`<table>` with `<caption>`, `<thead>`, `<th scope="col">` / `<th scope="row">`. For irregular
headers use `headers="id1 id2"` on the cells. Never use a table for layout; never use
`role="presentation"` to silence a real data table.

## Icon-only button
`<button aria-label="Close"><svg aria-hidden="true" focusable="false">…</svg></button>`.
The SVG is hidden from AT; the button carries the name. If a visible tooltip says "Close", the
accessible name must contain that same word (2.5.3).

## Form field with help and error
```html
<label for="dob">Date of birth</label>
<p id="dob-help">Use DD/MM/YYYY.</p>
<input id="dob" name="dob" aria-describedby="dob-help dob-err" aria-invalid="true" required>
<p id="dob-err" role="alert">Enter the date as DD/MM/YYYY, for example 05/11/1990.</p>
```
`aria-describedby` may reference several ids; keep the error id present in the list even when
the error element is empty.

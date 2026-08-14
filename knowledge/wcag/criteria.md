# WCAG 2.1 / 2.2 Success Criteria — auditor reference

Paraphrased intent + remediation notes, written for this tool's grounding. Not W3C
text. Official wording: https://www.w3.org/TR/WCAG22/ and the Understanding docs at
https://www.w3.org/WAI/WCAG22/Understanding/. Drop official/extra docs into this
folder as .md and they are indexed automatically.

Heading format is load-bearing: `## <number> <name> — Level <A|AA|AAA>`.

## 1.1.1 Non-text Content — Level A
All non-text content has a text alternative serving the equivalent purpose.
Common failures: missing `alt`; `alt` containing a filename; `alt="image of…"`; decorative
images with descriptive alt; `alt=""` on an image that is the only content of a link; icon
buttons with no accessible name; charts whose data is not available as text.
Fix: meaningful `alt` for informative images; `alt=""` (or `role="presentation"`) for purely
decorative ones; for a linked image, the alt must describe the link destination; for complex
images provide a longer description in adjacent text and reference it.

## 1.2.1 Audio-only and Video-only (Prerecorded) — Level A
Provide a transcript for audio-only, and a transcript or audio track for video-only.

## 1.2.2 Captions (Prerecorded) — Level A
Synchronised captions for all prerecorded audio in video. Auto-captions alone do not pass.

## 1.2.3 Audio Description or Media Alternative (Prerecorded) — Level A
Provide audio description or a full text alternative for prerecorded video.

## 1.2.4 Captions (Live) — Level AA
Live synchronised media has real-time captions.

## 1.2.5 Audio Description (Prerecorded) — Level AA
Audio description track for prerecorded video content.

## 1.2.6 Sign Language (Prerecorded) — Level AAA
Sign language interpretation for prerecorded audio.

## 1.2.7 Extended Audio Description (Prerecorded) — Level AAA
Extended audio description where pauses are insufficient.

## 1.2.8 Media Alternative (Prerecorded) — Level AAA
Full text alternative for prerecorded synchronised media.

## 1.2.9 Audio-only (Live) — Level AAA
Text alternative for live audio-only content.

## 1.3.1 Info and Relationships — Level A
Structure conveyed visually must be conveyed programmatically.
Common failures: layout tables; headings faked with `<b>`/font size; lists built from `<br>`;
data tables without `<th>`/`scope`/`caption`; form fields with no programmatic label; grouped
radios/checkboxes without `<fieldset>`/`<legend>`; landmarks missing so there is no `main`.
Fix: real semantic elements first (`<h1>`–`<h6>`, `<ul>`, `<table>` with `<th scope>`, `<label for>`,
`<fieldset><legend>`, `<main>`, `<nav>`); ARIA only where no native element exists.

## 1.3.2 Meaningful Sequence — Level A
When the reading sequence affects meaning, the DOM order must match it.
Common failures: CSS `order`/`flex-direction: row-reverse`/absolute positioning that moves
content visually without moving it in the DOM; a form's submit button before its inputs in DOM;
a caption preceding the thing it captions.
Fix: reorder the DOM to match the meaningful sequence; use CSS for presentation only.

## 1.3.3 Sensory Characteristics — Level A
Instructions must not rely solely on shape, size, position, sound, or visual orientation
("click the round button on the right"). Add a name or label reference.

## 1.3.4 Orientation — Level AA
Do not lock content to portrait or landscape unless essential.

## 1.3.5 Identify Input Purpose — Level AA
Fields collecting user information carry the correct `autocomplete` token
(`name`, `email`, `tel`, `street-address`, `postal-code`, `cc-number`, …).

## 1.3.6 Identify Purpose — Level AAA
Purpose of icons, regions and controls is programmatically determinable.

## 1.4.1 Use of Color — Level A
Colour must not be the only means of conveying information.
Common failures: links distinguished from body text by colour alone; required fields marked
red only; chart series identified only by colour.
Fix: add underline/icon/text/pattern in addition to colour.

## 1.4.2 Audio Control — Level A
Audio playing longer than 3 seconds must have a pause/stop or volume control.

## 1.4.3 Contrast (Minimum) — Level AA
Text contrast ≥ 4.5:1; large text (≥ 18.66px bold or ≥ 24px) ≥ 3:1.
Common failures: grey-on-white body text; placeholder text; text over images/gradients;
disabled-looking-but-active controls; text over a background set by an ancestor.
Fix: darken the foreground or lighten the background until the measured ratio passes. Use the
measured rendered values, not the declared CSS. Where text sits on an image, add a solid
backing or a scrim. Do not "fix" by making the text larger unless it genuinely crosses the
large-text threshold.

## 1.4.4 Resize Text — Level AA
Text can be resized to 200% without loss of content or function. Avoid fixed `px` heights on
text containers and `user-scalable=no`.

## 1.4.5 Images of Text — Level AA
Use real text rather than pictures of text, except for logos.

## 1.4.6 Contrast (Enhanced) — Level AAA
Text contrast ≥ 7:1 (≥ 4.5:1 for large text).

## 1.4.7 Low or No Background Audio — Level AAA
Background sound in speech audio is low or removable.

## 1.4.8 Visual Presentation — Level AAA
User control over foreground/background colours, width ≤ 80 characters, line spacing ≥ 1.5.

## 1.4.9 Images of Text (No Exception) — Level AAA
Images of text used only where essential.

## 1.4.10 Reflow — Level AA
No two-dimensional scrolling at 320 CSS px width (400% zoom).
Fix: responsive layout, avoid fixed widths, allow wrapping.

## 1.4.11 Non-text Contrast — Level AA
UI component boundaries and meaningful graphics have ≥ 3:1 contrast against adjacent colours.
Common failures: input borders too light; toggle states distinguished only by a low-contrast
fill; focus indicators below 3:1.

## 1.4.12 Text Spacing — Level AA
No loss of content when line-height 1.5×, paragraph spacing 2×, letter spacing 0.12em,
word spacing 0.16em are applied. Avoid fixed-height text containers with `overflow: hidden`.

## 1.4.13 Content on Hover or Focus — Level AA
Hover/focus-triggered content must be dismissible, hoverable, and persistent.

## 2.1.1 Keyboard — Level A
All functionality is operable by keyboard.
Common failures: `onclick` on a `<div>`/`<span>` with no `tabindex` and no key handler; custom
widgets that respond only to mouse; drag-only interactions.
Fix: use `<button>`/`<a href>`; if a custom element is unavoidable, add `role`, `tabindex="0"`
and Enter/Space handlers.

## 2.1.2 No Keyboard Trap — Level A
Focus can always move away using the keyboard. Modal dialogs must trap deliberately and
release on Escape.

## 2.1.3 Keyboard (No Exception) — Level AAA
Keyboard operable with no timing exceptions.

## 2.1.4 Character Key Shortcuts — Level A
Single-character shortcuts can be turned off, remapped, or are active only on focus.

## 2.2.1 Timing Adjustable — Level A
Time limits can be turned off, adjusted, or extended.

## 2.2.2 Pause, Stop, Hide — Level A
Moving, blinking, scrolling or auto-updating content lasting > 5s can be paused.
Common failures: carousels that auto-rotate with no pause control; marquee animations.

## 2.2.3 No Timing — Level AAA
No time limits on activities.

## 2.2.4 Interruptions — Level AAA
Interruptions can be postponed or suppressed.

## 2.2.5 Re-authenticating — Level AAA
Data is preserved across re-authentication.

## 2.2.6 Timeouts — Level AAA
Users are warned about data loss from inactivity timeouts.

## 2.3.1 Three Flashes or Below Threshold — Level A
Nothing flashes more than three times per second.

## 2.3.2 Three Flashes — Level AAA
No flashing more than three times per second at all.

## 2.3.3 Animation from Interactions — Level AAA
Motion animation from interactions can be disabled (`prefers-reduced-motion`).

## 2.4.1 Bypass Blocks — Level A
A mechanism skips repeated blocks of content.
Fix: a skip link as the first focusable element, targeting `<main id="main" tabindex="-1">`,
visible on focus; plus correct landmarks.

## 2.4.2 Page Titled — Level A
Every page has a unique, descriptive `<title>` naming the page then the site.

## 2.4.3 Focus Order — Level A
Focus order preserves meaning and operability.
Common failures: positive `tabindex` values; DOM order not matching visual order; modals that
leave focus behind them; focus not moved to newly revealed content.
Fix: rely on DOM order, use only `tabindex="0"` and `-1`, manage focus explicitly on route
change and dialog open/close.

## 2.4.4 Link Purpose (In Context) — Level A
The purpose of each link is clear from its text, or from its text plus context.
Common failures: "click here", "read more", "learn more", bare URLs, the same link text
pointing at different destinations.
Fix: make the link text name the destination ("Read the 2025 accessibility report"). If the
visible text must stay short, add `aria-label` carrying the full purpose — and keep the visible
text inside the accessible name (see 2.5.3).

## 2.4.5 Multiple Ways — Level AA
More than one way to locate a page (nav, search, sitemap).

## 2.4.6 Headings and Labels — Level AA
Headings and labels describe topic or purpose. Generic headings ("Section 1", "More") fail.

## 2.4.7 Focus Visible — Level AA
Keyboard focus is always visible.
Common failures: `outline: none` with no replacement; focus styles removed by a CSS reset;
indicator hidden behind a sticky header.
Fix: a visible indicator with ≥ 3:1 contrast against the adjacent background — `:focus-visible`
with an `outline` (and `outline-offset`), never `outline: 0` alone.

## 2.4.8 Location — Level AAA
The user's location within a set of pages is indicated (breadcrumbs, current state).

## 2.4.9 Link Purpose (Link Only) — Level AAA
Link purpose is clear from the link text alone.

## 2.4.10 Section Headings — Level AAA
Section headings organise the content.

## 2.4.11 Focus Not Obscured (Minimum) — Level AA
The focused element is not entirely hidden by author-created content (sticky headers/footers).
Fix: `scroll-margin-top` matching the sticky header height.

## 2.4.12 Focus Not Obscured (Enhanced) — Level AAA
No part of the focused component is obscured.

## 2.4.13 Focus Appearance — Level AAA
Focus indicator is at least 2 CSS px thick and meets a 3:1 contrast change.

## 2.5.1 Pointer Gestures — Level A
Multipoint or path-based gestures have a single-pointer alternative.

## 2.5.2 Pointer Cancellation — Level A
Actions complete on up-event, or can be aborted/undone.

## 2.5.3 Label in Name — Level A
The accessible name contains the visible label text, in the same order.
Common failure: a button reading "Search" with `aria-label="Submit query"` — voice users
saying "click Search" cannot activate it.

## 2.5.4 Motion Actuation — Level A
Device-motion-triggered functions have a UI alternative and can be disabled.

## 2.5.5 Target Size (Enhanced) — Level AAA
Targets are at least 44 × 44 CSS px.

## 2.5.6 Concurrent Input Mechanisms — Level AAA
Do not restrict input to a single modality.

## 2.5.7 Dragging Movements — Level AA
Any drag operation has a single-pointer alternative (buttons, menu, tap-then-tap).

## 2.5.8 Target Size (Minimum) — Level AA
Targets are at least 24 × 24 CSS px, or spaced so that 24 px circles do not overlap.
Fix: increase padding rather than font size; inline links in text are exempt.

## 3.1.1 Language of Page — Level A
`<html lang="…">` is present and correct.

## 3.1.2 Language of Parts — Level AA
Passages in another language carry their own `lang`.

## 3.1.3 Unusual Words — Level AAA
Definitions available for jargon and idiom.

## 3.1.4 Abbreviations — Level AAA
Expansions available for abbreviations.

## 3.1.5 Reading Level — Level AAA
A simpler alternative exists for content above lower-secondary reading level.

## 3.1.6 Pronunciation — Level AAA
Pronunciation available where meaning is ambiguous without it.

## 3.2.1 On Focus — Level A
Receiving focus does not trigger a change of context.

## 3.2.2 On Input — Level A
Changing a setting does not automatically change context unless the user was warned.
Common failure: a `<select>` that navigates on change with no Go button.

## 3.2.3 Consistent Navigation — Level AA
Repeated navigation appears in the same relative order across pages.

## 3.2.4 Consistent Identification — Level AA
The same function is labelled consistently across pages.

## 3.2.5 Change on Request — Level AAA
Context changes only on explicit request.

## 3.2.6 Consistent Help — Level A
Help mechanisms appear in the same relative order on every page that has them.

## 3.3.1 Error Identification — Level A
Errors are described in text and the field in error is identified.
Fix: text error message next to the field, referenced by `aria-describedby`, with
`aria-invalid="true"`; announce the summary in a live region; never colour alone.

## 3.3.2 Labels or Instructions — Level A
Labels or instructions are provided when content requires user input.
Common failures: placeholder used as the only label; required fields not marked; format
requirements stated only after a failed submit.
Fix: persistent visible `<label for>`; state format and constraints in help text tied via
`aria-describedby`; mark required in the accessible name or with `required`.

## 3.3.3 Error Suggestion — Level AA
When an error is detected and a correction is known, suggest it ("Enter a date as DD/MM/YYYY").

## 3.3.4 Error Prevention (Legal, Financial, Data) — Level AA
Submissions are reversible, checked, or confirmed.

## 3.3.5 Help — Level AAA
Context-sensitive help is available.

## 3.3.6 Error Prevention (All) — Level AAA
Reversible/checked/confirmed for all submissions.

## 3.3.7 Redundant Entry — Level A
Information already entered in the same process is auto-populated or selectable.

## 3.3.8 Accessible Authentication (Minimum) — Level AA
No cognitive function test (puzzle, transcription, memorisation) unless an alternative exists.
Allow paste into password fields and support password managers.

## 3.3.9 Accessible Authentication (Enhanced) — Level AAA
No cognitive function test at all.

## 4.1.1 Parsing — obsolete
Removed in WCAG 2.2 and always passes in 2.1. Do not report duplicate-id or unclosed-tag
findings against this criterion; map them to the criterion actually affected (usually 1.3.1
or 4.1.2) or report them as code quality.

## 4.1.2 Name, Role, Value — Level A
Every UI component exposes a name, a role, and its state/value to assistive technology.
Common failures: `<div onclick>` acting as a button; icon buttons with no name; custom
checkboxes without `aria-checked`; `aria-expanded` never updated; `aria-labelledby` pointing at
a missing id.
Fix: native elements first. For custom widgets set `role`, an accessible name
(`aria-label`/`aria-labelledby`), and keep state attributes in sync with the visual state.

## 4.1.3 Status Messages — Level AA
Status messages are exposed without moving focus.
Fix: `role="status"` / `aria-live="polite"` (or `role="alert"` for errors) on a container that
exists in the DOM before the message is inserted.

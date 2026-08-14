# Contrast — the design system for the accessibility audit agent

Named for the obvious reason: contrast is what this tool measures, and what its own interface has
to get right. **Every colour pair in this document is measured, not eyeballed, and the tool audits
its own UI on every check (`npm run audit:ui`) — zero axe violations is a build condition, not an
aspiration.**

## Where it comes from

| Source | What it gave us |
|---|---|
| [Anthropic / Claude brand](https://www.anthropic.com/news/claude-design-anthropic-labs) | Cream canvas `#faf9f5`, coral `#cc785c`, warm ink `#141413`, warm-dark surfaces `#181715`. Serif display + humanist sans + mono pairing. Warm neutrals instead of the blue-grey every other dev tool uses. |
| [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) | The "inverted L" chrome — persistent sidebar plus top bar framing one content surface. Density through alignment rather than shrinking. Text darkened in light, lightened in dark. |
| Terminal tooling (Claude Code, Warp, Raycast) | Monospace as a *semantic* choice for machine identifiers. Command palette as the primary accelerator. Dark treated as a first-class surface, not an inversion. |
| git / GitHub history | Runs are versions. A vertical rail with deltas between adjacent commits is the mental model auditors already have. |

## The one idea

**An audit is not a report, it is a version.** A client accumulates runs the way a repo accumulates
commits, and the interesting information lives in the *deltas* — what got fixed, what regressed,
what has been sitting there for six months. So navigation is organised
`client → run → finding`, with the run rail always showing change since the previous run.

---

## Tokens

All tokens live in `src/ui/public/tokens.css`. Nothing in the app hardcodes a colour.

### Colour

Two themes, both authored deliberately. Light is a warm cream canvas; dark is warm-dark, never
blue-black. The toggle persists; default follows the OS.

| Role | Light | Dark |
|---|---|---|
| `--canvas` | `#faf9f5` | `#181715` |
| `--surface` | `#ffffff` | `#1f1e1b` |
| `--surface-2` | `#f5f0e8` | `#252320` |
| `--line` | `#e6dfd8` | `#302e2a` |
| `--text` | `#141413` | `#faf9f5` |
| `--text-2` | `#3d3d3a` | `#d6d3cc` |
| `--text-3` | `#6c6a64` (5.3:1) | `#a09d96` (6.2:1) |
| `--accent` | `#cc785c` | `#cc785c` |
| `--accent-text` | `#a25439` (5.1:1 canvas, 4.75:1 sidebar) | `#e09277` (6.4:1) |

Coral is the brand accent but **fails as body text on cream at 3.1:1**, so it is used for fills,
rails and indicators only; `--accent-text` is the darkened variant used wherever coral must carry
words. Primary buttons are coral with *ink* text (5.7:1), not white (3.3:1).

### Meaning, encoded twice

Deterministic and AI-assessed findings must never be distinguishable by colour alone (1.4.1), so
each carries **a colour, a border weight, and a text label**:

- **Deterministic** — neutral ink, square left rule, label `MEASURED`. It is a fact.
- **AI-assessed** — coral, dotted left rule, label `ASSESSED`. It is a judgment.

Severity uses soft tinted badges (`--sev-*-bg` / `--sev-*-fg`), tuned per theme so the foreground
clears 4.5:1 on its own tint in both.

### Type

| Token | Stack | Used for |
|---|---|---|
| `--font-display` | Tiempos Headline, Iowan Old Style, Palatino, Georgia, serif | Page and section titles only |
| `--font-ui` | Inter, -apple-system, Segoe UI, sans-serif | Everything else |
| `--font-mono` | JetBrains Mono, ui-monospace, SFMono-Regular, Consolas, monospace | Run ids, selectors, rules, code, counts |

No webfonts are loaded. This tool runs on an auditor's laptop against client sites, sometimes
offline; a CDN font request is a dependency and a privacy leak for zero benefit.

**Monospace is semantic here.** If a string is a machine identifier — a run id, a CSS selector, an
axe rule, a WCAG number — it is mono. If a human wrote it, it is not. That rule alone does most of
the hierarchy work in a dense list.

Scale: `12 / 13 / 14 / 15 / 18 / 22 / 28px`. Body is 14px at 1.55; the display serif starts at 22.

### Space, radius, motion

Space is a 4px scale: `4 8 12 16 24 32 48`. Radius: `4 / 6 / 8 / 12 / pill`.

Motion tokens are this system's own invention — the Claude reference explicitly leaves them out:

| Token | Value | For |
|---|---|---|
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | Everything. One curve, decisive-then-settling. |
| `--t-1` | `120ms` | State on a thing under the cursor (hover, press) |
| `--t-2` | `200ms` | Something appearing or leaving |
| `--t-3` | `420ms` | Something explaining itself (rail draw, count-up, bars) |

Rule: **motion may explain, never announce.** A bar growing to its width shows proportion. A
spinning logo shows nothing. Under `prefers-reduced-motion: reduce` every duration collapses to
`1µs` and all values render final — verified in the test suite, not assumed.

### The mark

<img alt="The mark in three states: a static C when idle, a partial ring at 35% progress, a full ring at 100%" src="docs/mark-states.png" width="520">

The **C** is one SVG ring with a gap — the gap is what makes it a C rather than an O — and it is
the only loader in the product. An SVG circle starts at 3 o'clock and runs clockwise, so an
un-rotated gap lands on the left and reads as a mirrored C; the ring is rotated by half the gap
(47°) to put the opening on the right, where a C's opening belongs. It carries three states, and
the third is why it exists:

| State | What it does | When |
|---|---|---|
| `idle` | a static C | nothing is running |
| `running` | the gap chases its own tail | work started, length unknown |
| `progress` | the ring fills | the page budget is known |

A spinner that spins forever is decoration; a ring that fills to `3 of 3 pages scanned` is a
progress report. The same mark, inline at `1em`, is the spinner on any pending button, and at
56px in `--line-strong` it is the empty-state watermark. Under reduced motion the sweep stops and
a half-drawn ring stands in — the meaning survives, the movement does not. The count is also
announced to screen readers through a visually hidden `role="status"`, because a ring is not
information if you cannot see it.

---

## Layout

```
┌──────────────┬────────────────────────────────────────────┐
│              │  breadcrumb            theme   ⌘K   status │  56px top bar
│  sidebar     ├────────────────────────────────────────────┤
│  256px       │  Overview │ Findings │ History │ Compare    │  view tabs
│              ├────────────────────────────────────────────┤
│  clients     │                                            │
│   └ runs     │  content surface                           │
│     (versions│                                            │
│      + delta)│                                            │
└──────────────┴────────────────────────────────────────────┘
```

The sidebar is the version tree: clients expand into runs, newest first, each run showing its
delta against the previous one (`−12` fixed, `+3` new). That column is the whole point of the
redesign — it is how you navigate between audits and their versions.

## Components

`btn` (`.primary` / `.ghost` / `.danger`), `chip`, `badge`, `rail` + `rail-node`, `stat`, `bar`,
`card`, `field`, `palette`, `console`, `finding`, `tab`, `toast`, `skeleton`.

## Keyboard

The tool is for people who live in a terminal, and it is an accessibility tool — so the keyboard
path is the primary path, not a fallback.

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette — jump to any client, run, or action |
| `/` | Focus search |
| `1` `2` `3` `4` | Overview / Findings / History / Compare |
| `Esc` | Close palette, or go back |
| `Tab` | Everything is reachable. Focus is always visible: 2px coral ring, 2px offset. |

## Rules

1. Nothing is distinguished by colour alone.
2. Focus is never removed, only restyled.
3. Every measured number keeps its units and its provenance — "4.27:1 measured" not "low contrast".
4. Certainty is visible at a glance: measured facts and model judgments never look alike.
5. The interface states its own limits where the numbers are, not in a footer nobody reads.

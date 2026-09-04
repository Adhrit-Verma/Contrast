# G2 / Capterra free listing copy

## Product name
Contrast

## Category
Accessibility Testing Software / Web Accessibility Compliance

## Tagline (≤80 chars)
AI-assisted accessibility audits that verify every fix before calling it done.

## Short description (~150 chars, listing summary)
Crawls your site, measures what a machine can prove, judges what it can't,
writes fixes, and re-tests every one in a fresh browser before calling it fixed.

## Long description (listing body)
Contrast is an AI-assisted accessibility auditing tool built for teams of
human auditors, not as a replacement for them. It crawls a site — including
pages behind a login — and separates every finding into two kinds that are
never allowed to look alike: **measured** facts from axe-core, the Chrome
accessibility tree, and a real keyboard-navigation trace, and **assessed**
judgment calls from an AI model on the things machines are bad at (alt-text
quality, link and heading semantics, form errors, reading order).

Every proposed fix is grounded in WCAG text and your own house patterns, then
injected into a fresh browser and re-scanned — resolved and no new violations
introduced, or it's labelled a suggestion, not a fix. Reports include a
run-to-run diff (what got fixed, what's new, what's still broken) and a
VPAT/ACR first draft, both clearly marked as drafts a human auditor completes,
never a finished conformance claim.

## Key features
- Read-only crawler: GET-only, denylist-guarded, never touches
  logout/delete/destructive endpoints
- axe-core + Chrome accessibility tree + real keyboard-trace, deduplicated
  into one finding schema
- Five AI-assessed judgment tasks: alt-text quality, link/button text, heading
  semantics, form quality, reading order
- Verified fix loop: every fix re-injected and re-scanned in a fresh page
  before being called resolved
- Run-to-run diff view and VPAT/ACR draft generator
- Automated coverage against the actual WCAG catalogue, so a report never
  implies a clean bill of health for criteria nothing checked

## Pricing
Free during beta. The deterministic scanner (no AI, no account) is free and
unlimited-scope at [contrast's public scanner]; full AI-assisted audits are
free while we're still building out the paid tier.

## Best for
Accessibility consultancies and in-house auditors who need to move faster
through the measurable ~30–40% of WCAG without losing the distinction between
what's proven and what's judged.

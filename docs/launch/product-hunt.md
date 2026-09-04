# Product Hunt launch copy

## Tagline (≤60 chars)
Accessibility audits that verify their own fixes

## Description (the card blurb, ~250 chars)
Contrast crawls your site, measures what a machine can prove (axe-core, a real
keyboard trace, computed contrast), asks AI about what machines get wrong
(alt-text quality, link text, heading structure), then re-tests every fix in a
fresh browser before calling it fixed. Free deterministic scanner, no signup.

## First comment (post as the maker, right after launch)

Hey Product Hunt 👋

I kept using accessibility scanners that reported a model's best guess and a
confirmed axe-core violation as if they were the same kind of fact. They
aren't — one is measured, one is judged — and mixing them up is exactly how
"the scanner said it's fine" turns into a lawsuit.

So Contrast tags every finding as **measured** or **assessed**, never blurs
the line, and goes one step further for AI-assessed judgment calls: when it
proposes a fix, it doesn't just suggest it — it injects the fix into a fresh
page, re-scans, and only calls it "fixed" if the violation is actually gone
and nothing new broke. Anything unverified is labelled a suggestion, not a
result.

Free tier runs the full deterministic pipeline (axe-core + Chrome
accessibility tree + real keyboard trace) on up to 5 pages, no account
needed: [link to /scan]. We also ran it against 8 major Indian company sites
before launch and published exactly what it found, findings and all —
[link to /audits/summary] — because I'd rather you see real output than take
my word for it.

Would love feedback, especially from anyone who's shipped a VPAT/ACR before —
that draft generator is the part I'm least sure we got right yet.

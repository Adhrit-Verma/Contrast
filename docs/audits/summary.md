# I ran an automated accessibility scanner against 20 of India's biggest websites. Only 8 let it finish.

We built [Contrast](../../README.md), an AI-assisted accessibility auditing tool, and wanted to
see what it found on real, high-traffic Indian sites — not demo pages. So we pointed it, read-only
and GET-only, at banks, e-commerce platforms, a government portal, an airline, a healthcare
platform, and a few more. Four pages each, homepage and a couple of links deep, nothing behind a
login.

**The scan itself is not remarkable** — it's the same axe-core, Chrome-accessibility-tree, and
keyboard-trace checks a browser extension or Lighthouse would run. What's actually interesting is
what happened when we pointed it at 20 major Indian domains.

## The headline: more than half refused to be scanned at all

| Outcome | Count | Sites |
|---|---|---|
| Scanned successfully | 8 | Flipkart, Jio, State Bank of India, Times of India, Paytm, Domino's India, Lenskart, Tata 1mg |
| Blocked by bot protection | 11 | HDFC Bank, India.gov.in, Myntra, Air India, Zomato, BookMyShow, NDTV, MakeMyTrip, Policybazaar, Croma, Nykaa |
| Served a fallback page that looked real | 1 | IndiGo |

That's not a criticism of those 11 — refusing unrecognized automated traffic is a completely
reasonable security posture, and Contrast is built to detect exactly this and **stop rather than
report on the challenge page as if it were the real site**. When we hit a Cloudflare "Attention
Required" page, an "Access Denied" interstitial, or a connection-level `ERR_HTTP2_PROTOCOL_ERROR`
from an edge WAF, the tool logged it, abandoned the scan, and moved on — zero findings recorded,
because there was nothing real to find.

## The one that almost got past us

IndiGo's homepage returned a normal HTTP 200 — no challenge page, no obvious block. Contrast
dutifully reported 8 findings: no page title, no `lang` attribute, a broken image, a link with no
name. All technically true. All describing the wrong page.

The image path gave it away: `akamfailoverpage/indigologo.svg`. We'd scanned Akamai's *bot-defense
fallback page*, not IndiGo's real site — it just happened to return 200 instead of 403, which
slipped past the automated block-detector entirely. We caught it by hand before publishing this,
because a scanner confidently reporting on the wrong page is worse than a scanner that reports
nothing. That finding is excluded from what follows, and it's now a known gap in how the tool
detects blocks — a page that returns 200 but is otherwise near-empty deserves the same suspicion
as an explicit 403.

## What the 8 that did get scanned had in common

- **Text contrast was the single most common failure** — present on every one of the 8 sites, and
  the majority finding by volume on Paytm (544 of 780) and Tata 1mg (219 of 326).
- **Keyboard focus you can't see** showed up on Flipkart, Jio, Times of India, and Paytm — on
  Times of India alone, 160 separate tab stops give no visible sign they have focus.
- **A missing `<main>` landmark** — Flipkart, IndiGo (before we excluded it), Domino's, and SBI's
  redirect page all lack one, meaning screen reader users can't jump straight to page content on
  four of eight sites checked.
- **The single most serious individual finding**: SBI's own redirect page force-refreshes after
  exactly 5 seconds with no way to pause or extend it (WCAG 2.2.1) — a real timing violation on
  a page every visitor to sbi.co.in passes through.
- **The highest finding count**: Times of India, at 990 — driven by a dense stack of navigation,
  ad, and carousel widgets, each repeating the same handful of problems dozens of times over.

## Read the individual reports

- [Flipkart](flipkart.md) — 122 findings
- [Jio](jio.md) — 28 findings
- [State Bank of India](sbi.md) — 9 findings, including a real WCAG 2.2.1 timing violation
- [Times of India](times-of-india.md) — 990 findings
- [Paytm](paytm.md) — 780 findings
- [Domino's India](dominos-india.md) — 15 findings, including the homepage's own "Order Online" button
- [Lenskart](lenskart.md) — 147 findings
- [Tata 1mg](tata-1mg.md) — 326 findings, on a healthcare platform where this matters more than most

## The honest limits

This measured what a machine can prove — axe-core, the accessibility tree, keyboard traces.
It did not run Contrast's AI-assessed checks (alt-text *quality*, whether link text actually
makes sense, heading structure), and it did not touch anything behind a login: no checkout, no
account pages, no payment flows. Automated tools like this one catch roughly 30–40% of WCAG
success criteria — what's listed here is real and specific, but it's a floor, not a ceiling, and
none of it is a claim of conformance.

// What donations actually unlock, in the order they'd get done. Every tier
// here is a real open item from this project's own backlog — no invented
// roadmap. Keep it that way: a funding goal you don't intend to deliver is
// the fastest way to lose the trust the rest of this tool is built on.
export const GOALS = [
  { at: 15, title: 'A real domain + HTTPS', why: 'The public scanner runs on a bare IP over plain HTTP today. A domain and a cert are the whole fix.' },
  { at: 40, title: 'AI review on free scans', why: 'A paid Gemini tier, so public scans get the alt-text / link-text / heading judgment calls, not just the measurable rules.' },
  { at: 90, title: 'Bigger scans for everyone', why: 'More VPS headroom: past 5 pages per scan, and more scans per hour before the rate limit bites.' },
  { at: 200, title: 'Close the known gaps', why: 'DNS-rebind protection on the SSRF guard, and a blocked-page detector that catches 200-status bot-defense fallbacks.' },
];

export const CURRENCY = '$';

/**
 * Progress against the ladder. Pure so the tier maths has a test behind it
 * rather than only ever being exercised by eyeballing the rendered bar.
 */
export function fundingState(raised = 0, goals = GOALS) {
  const amount = Math.max(0, Number(raised) || 0);
  const target = goals.length ? goals[goals.length - 1].at : 0;
  const next = goals.find((g) => amount < g.at) ?? null;
  return {
    raised: amount,
    target,
    // Progress across the whole ladder, so the bar keeps moving between tiers
    // instead of resetting each time one is cleared.
    percent: target ? Math.min(100, Math.round((amount / target) * 100)) : 0,
    next,
    goals: goals.map((g) => ({ ...g, reached: amount >= g.at })),
  };
}

// ponytail: `raised` comes from one env var the operator bumps by hand.
// Buy Me a Coffee has no unauthenticated read API, so genuinely-live totals
// need a creator API token + a cached server-side fetch — swap the body of
// this one function for that call when there's a token to use.
export function currentRaised() {
  return Number(process.env.FUNDING_RAISED ?? 0) || 0;
}

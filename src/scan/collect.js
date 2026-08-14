// Raw collectors. Each returns tool-shaped data; normalize.js turns it into Findings.
import { AxePuppeteer } from '@axe-core/puppeteer';
import axeCore from 'axe-core';
import lighthouse from 'lighthouse';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withTimeout } from '../timeout.js';

export const slug = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- axe

// axe's own metadata is the only honest source for rule -> WCAG mapping.
// Never hand-maintain that table. Available straight from the node module.
export const axeRuleMeta = () => axeCore.getRules();

/**
 * Entrance animations make axe measure half-transparent text and report contrast
 * failures that do not exist. Wait for finite animations to finish first —
 * infinite ones (spinners, pulses) never would, so they are excluded and the
 * whole wait is capped.
 */
export async function settleAnimations(page, timeoutMs = 2000) {
  await page
    .evaluate(
      (cap) =>
        Promise.race([
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {}))
          ),
          new Promise((r) => setTimeout(r, cap)),
        ]),
      timeoutMs
    )
    .catch(() => {});
}

export async function runAxe(page) {
  // @axe-core/puppeteer throws "Page/Frame is not ready" unless readyState is
  // complete — the crawler only waits for domcontentloaded, so wait here.
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
  await settleAnimations(page);
  // Pass axe's source explicitly: from ESM, @axe-core/puppeteer resolves
  // axe-core through a double-encoded file URL and dies on any path with a
  // space in it ("C:\Code\AI%20Agents\..."). We already have the module.
  const results = await new AxePuppeteer(page, axeCore.source).analyze();
  return { ...results, ruleMeta: axeRuleMeta() };
}

// ---------------------------------------------------------- lighthouse

// Lighthouse drives the whole tab; two at once on one browser fight over CDP.
// ponytail: one global chain, not a real semaphore — LH is the slow path anyway.
let lhChain = Promise.resolve();

export function runLighthouse(page, url, cfg = {}) {
  // Lighthouse has no internal deadline and is the single most common place an
  // audit wedges — give it its own budget so it cannot eat the page budget.
  const next = lhChain.then(() => withTimeout(lighthouseOnce(page, url, cfg), cfg.timeoutMs ?? 75000, `lighthouse on ${url}`));
  lhChain = next.catch(() => {});
  return next;
}

async function lighthouseOnce(page, url, cfg) {
  const flags = {
    logLevel: 'error',
    output: 'json',
    onlyCategories: ['accessibility'],
    disableStorageReset: true, // MUST stay true — otherwise it wipes the auth session
    screenEmulation: { disabled: true },
    formFactor: cfg.formFactor ?? 'desktop',
    throttlingMethod: 'provided',
    ...cfg.flags,
  };
  const result = await lighthouse(url, flags, undefined, page);
  const lhr = result?.lhr;
  if (!lhr) return { audits: [], score: null };
  const refs = lhr.categories?.accessibility?.auditRefs ?? [];
  const audits = refs
    .map((ref) => lhr.audits[ref.id])
    .filter((a) => a && a.scoreDisplayMode !== 'notApplicable' && a.score !== null && a.score < 1);
  return { audits, score: lhr.categories?.accessibility?.score ?? null };
}

// ------------------------------------------------------- a11y tree

export const a11yTree = (page, interestingOnly = true) =>
  page.accessibility.snapshot({ interestingOnly }).catch(() => null);

// --------------------------------------------------- keyboard trace

const FOCUSABLE =
  'a[href],button,input,select,textarea,summary,iframe,audio[controls],video[controls],[tabindex],[contenteditable=""],[contenteditable="true"]';

/* eslint-env browser */ // runs inside the page, not in Node
// Snapshot the focusable elements ONCE per page. Re-running querySelectorAll +
// getComputedStyle on every Tab press turned a 40-stop trace into thousands of
// full-DOM scans — on a large app that is the "browser stuck tabbing" you see.
const indexFocusables = (FOCUSABLE) => {
  window.__a11yFocusables = [...document.querySelectorAll(FOCUSABLE)].filter((e) => {
    const cs = getComputedStyle(e);
    return e.getClientRects().length && cs.visibility !== 'hidden' && e.tabIndex > -1;
  });
  return window.__a11yFocusables.length;
};

const focusStep = () => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const path = (n) => {
    const parts = [];
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.nodeName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + CSS.escape(n.id)); break; }
      const sibs = n.parentNode ? [...n.parentNode.children].filter(c => c.nodeName === n.nodeName) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const all = window.__a11yFocusables ?? [];
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    selector: path(el),
    tag: el.nodeName.toLowerCase(),
    name: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80),
    domIndex: all.indexOf(el),
    tabindex: el.getAttribute('tabindex'),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
    boxShadow: cs.boxShadow,
    html: el.outerHTML.slice(0, 300),
  };
};

/**
 * Tab through the page and record where focus actually lands. Bounded three
 * ways — tab count, wall clock, and repeats — because a single-page app can
 * hold hundreds of focusable nodes and this is not the interesting part of an
 * audit.
 */
export async function keyboardTrace(page, maxTabs = 40, budgetMs = 20000) {
  const trace = [];
  const seen = new Set();
  const deadline = Date.now() + budgetMs;
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  const focusableCount = await page.evaluate(indexFocusables, FOCUSABLE).catch(() => 0);
  const stops = Math.min(maxTabs, Math.max(1, focusableCount + 1));

  for (let i = 0; i < stops; i++) {
    if (Date.now() > deadline) {
      console.log(`    keyboard trace stopped at ${trace.length} stops (${Math.round(budgetMs / 1000)}s budget)`);
      break;
    }
    await page.keyboard.press('Tab');
    const s = await page.evaluate(focusStep).catch(() => null);
    if (!s) break;
    if (seen.has(s.selector)) break; // wrapped or trapped
    seen.add(s.selector);
    trace.push(s);
  }
  return trace;
}

// ------------------------------------------------- AI candidate inventory

/**
 * Everything the Phase 3 judgment tasks need, pulled from the live DOM in one
 * pass. Deterministic collection; the AI only judges what is collected here.
 * NOTE: `path()` is duplicated from focusStep above — the two run in isolated
 * page contexts and cannot share a Node-side helper without in-page eval (CSP).
 */
const inventoryFn = (limits) => {
  const path = (n) => {
    const parts = [];
    while (n && n.nodeType === 1 && parts.length < 6) {
      let s = n.nodeName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + CSS.escape(n.id)); break; }
      const sibs = n.parentNode ? [...n.parentNode.children].filter((c) => c.nodeName === n.nodeName) : [];
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    return el.getClientRects().length && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const near = (el) => {
    const t = (el.closest('figure')?.querySelector('figcaption')?.innerText ?? '').trim();
    return (t || (el.parentElement?.innerText ?? '')).trim().slice(0, 200);
  };

  const images = [...document.querySelectorAll('img, [role="img"], svg[aria-label]')]
    .filter(visible)
    .slice(0, limits.images)
    .map((el) => ({
      selector: path(el),
      src: el.getAttribute('src') ?? null,
      alt: el.getAttribute('alt'),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      linked: !!el.closest('a'),
      linkHref: el.closest('a')?.getAttribute('href') ?? null,
      context: near(el),
      html: el.outerHTML.slice(0, 300),
    }));

  const links = [...document.querySelectorAll('a[href], button, [role="button"], [role="link"]')]
    .filter(visible)
    .slice(0, limits.links)
    .map((el) => ({
      selector: path(el),
      text: (el.innerText ?? '').trim().slice(0, 120),
      ariaLabel: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      href: el.getAttribute('href'),
      context: (el.closest('li,p,td,section,nav')?.innerText ?? '').trim().slice(0, 200),
      html: el.outerHTML.slice(0, 250),
    }));

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
    .filter(visible)
    .slice(0, limits.headings)
    .map((el) => ({
      selector: path(el),
      level: Number(el.getAttribute('aria-level') ?? el.nodeName.slice(1)) || null,
      text: (el.innerText ?? '').trim().slice(0, 120),
    }));

  const fields = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
    .filter(visible)
    .slice(0, limits.fields)
    .map((el) => {
      const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      return {
        selector: path(el),
        type: el.type ?? el.nodeName.toLowerCase(),
        name: el.name || null,
        required: el.required || el.getAttribute('aria-required') === 'true',
        label: (id?.innerText ?? el.closest('label')?.innerText ?? '').trim().slice(0, 120) || null,
        ariaLabel: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder'),
        describedBy: el.getAttribute('aria-describedby'),
        describedByText: (el.getAttribute('aria-describedby') ?? '')
          .split(/\s+/).filter(Boolean)
          .map((r) => document.getElementById(r)?.innerText?.trim() ?? '')
          .join(' ').slice(0, 200) || null,
        invalid: el.getAttribute('aria-invalid'),
        html: el.outerHTML.slice(0, 250),
      };
    });

  // Reading order: DOM sequence vs. rendered position. CSS can reorder either.
  const blocks = [...document.querySelectorAll('main p, main li, main h1, main h2, main h3, article p, section p, p, li')]
    .filter(visible)
    .slice(0, limits.blocks)
    .map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        selector: path(el),
        domIndex: i,
        x: Math.round(r.x + window.scrollX),
        y: Math.round(r.y + window.scrollY),
        text: (el.innerText ?? '').trim().slice(0, 100),
      };
    });

  return { images, links, headings, fields, blocks, title: document.title, lang: document.documentElement.lang };
};

export const pageInventory = (page, limits = {}) =>
  page.evaluate(inventoryFn, {
    images: limits.images ?? 40,
    links: limits.links ?? 120,
    headings: limits.headings ?? 60,
    fields: limits.fields ?? 60,
    blocks: limits.blocks ?? 80,
  });

// -------------------------------------------------------- screenshots

const RULE_PROPS = {
  'color-contrast': ['color', 'background-color', 'font-size', 'font-weight', 'opacity'],
  'color-contrast-enhanced': ['color', 'background-color', 'font-size', 'font-weight'],
  'link-in-text-block': ['color', 'background-color', 'text-decoration'],
  'target-size': ['width', 'height', 'padding', 'display'],
  'focus-not-visible': ['outline', 'outline-offset', 'box-shadow'],
};
const DEFAULT_PROPS = ['display', 'visibility', 'position'];

export const stylePropsFor = (ruleId) => RULE_PROPS[ruleId] ?? DEFAULT_PROPS;

export async function computedStylesFor(page, selector, ruleId) {
  const props = stylePropsFor(ruleId);
  return page
    .$eval(
      selector,
      (el, p) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(p.map((k) => [k, cs.getPropertyValue(k)]));
      },
      props
    )
    .catch(() => null);
}

export async function screenshotPage(page, dir, url) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug(url)}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => null);
  return path;
}

/** Bounding-box shot of one flagged element. Returns null when off-screen/hidden. */
export async function screenshotElement(page, selector, dir, name) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  try {
    const el = await page.$(selector);
    if (!el) return null;
    const box = await el.boundingBox();
    if (!box || box.width < 1 || box.height < 1) return null;
    const pad = 8;
    const vp = page.viewport() ?? { width: 1440, height: 900 };
    await page.screenshot({
      path,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(box.width + pad * 2, vp.width),
        height: Math.min(box.height + pad * 2, 2000),
      },
    });
    return path;
  } catch {
    return null;
  }
}

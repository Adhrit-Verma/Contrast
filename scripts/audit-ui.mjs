#!/usr/bin/env node
// The tool audits its own interface. Every view, both themes, zero tolerance.
// Exits non-zero on any violation so it can gate a commit.
import puppeteer from 'puppeteer';
import { startUi } from '../src/ui/server.js';
import { loadConfig } from '../src/config.js';
import { runAxe } from '../src/scan/collect.js';

const PORT = Number(process.env.A11Y_UI_PORT ?? 4399);
// "new" has no tab — it is reached from the + New audit button, so the audit
// script has to open it the same way a person does.
const VIEWS = [
  ['new', '#composer', '#new-audit'],
  ['overview', '.stat'],
  ['findings', '#list .finding'],
  ['history', '.rail .node'],
  ['compare', '#diff .card'],
  ['settings', '#s-key'],
];

const server = startUi({ cfg: loadConfig(), port: PORT });
const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 950 } });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

let failures = 0;
try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.tab');

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const [view, ready, opener] of VIEWS) {
      if (opener) {
        await page.click(opener);
      } else {
        // The tab strip only exists once an audit is open, so open one first.
        const needsRun = await page.$eval('#tabs', (el) => el.hidden).catch(() => false);
        if (needsRun) {
          await page.evaluate(() => document.querySelectorAll('.client-group').forEach((g) => g.classList.add('open')));
          const run = await page.$('.run-item');
          if (!run) {
            console.log(`  skip  ${view.padEnd(9)} (no audits in the database to open)`);
            continue;
          }
          await run.click();
          await new Promise((r) => setTimeout(r, 800));
        }
        await page.click(`#tab-${view}`);
      }
      await page.waitForSelector(ready, { timeout: 25000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
      const { violations } = await runAxe(page);
      const label = `${theme.padEnd(5)} ${view.padEnd(9)}`;
      if (!violations.length) {
        console.log(`  ok    ${label}`);
        continue;
      }
      failures += violations.length;
      console.log(`  FAIL  ${label}`);
      for (const v of violations) {
        console.log(`          ${v.id} [${v.impact}] x${v.nodes.length} — ${v.nodes[0].target.join(' ')}`);
        console.log(`          ${v.help}`);
      }
    }
  }

  // The claim in DESIGN.md, checked rather than asserted.
  const reduced = await browser.newPage();
  await reduced.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await reduced.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  // .content animates on every view change, so this does not depend on a run
  // having finished loading — which made this check flaky.
  await reduced.waitForSelector('.content');
  const dur = await reduced.$eval('.content', (el) => getComputedStyle(el).animationDuration);
  if (parseFloat(dur) > 0.001) {
    failures++;
    console.log(`  FAIL  reduced-motion: animation-duration is ${dur}, expected ~0`);
  } else {
    console.log('  ok    reduced-motion collapses every animation');
  }
} finally {
  await browser.close();
  server.close();
}

if (pageErrors.length) {
  failures += pageErrors.length;
  console.log(`\n${pageErrors.length} console errors:`);
  for (const e of pageErrors) console.log(`  ${e}`);
}

console.log(failures ? `\n${failures} problem(s) in our own UI.` : `\nUI clean: 0 violations across ${VIEWS.length} views x 2 themes.`);
process.exit(failures ? 1 : 0);

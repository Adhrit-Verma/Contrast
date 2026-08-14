#!/usr/bin/env node
// Records the GIFs and stills used by the README, by driving the real app.
// Frames are captured with Puppeteer and assembled by ffmpeg. Nothing here is
// mocked — if a recording looks wrong, the app is wrong.
//
//   node scripts/record-docs.mjs            (dashboard must be running)
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.A11Y_UI_URL ?? 'http://localhost:4321';
const DOCS = 'docs';
const TMP = join(process.env.TEMP ?? '/tmp', 'contrast-frames');
const VIEW = { width: 1280, height: 820, deviceScaleFactor: 1 };

mkdirSync(DOCS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Capture frames as fast as the page will give them, while `actions` runs. */
async function record(page, name, actions, { fps = 12, speed = 1, width = 900 } = {}) {
  const dir = join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let n = 0;
  let capturing = true;
  const loop = (async () => {
    while (capturing) {
      await page.screenshot({ path: join(dir, `${String(n++).padStart(4, '0')}.png`) }).catch(() => {});
      await sleep(90);
    }
  })();

  await actions();
  capturing = false;
  await loop;

  const out = join(DOCS, `${name}.gif`);
  const filters = `setpts=${(1 / speed).toFixed(3)}*PTS,fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '11', '-i', join(dir, '%04d.png'), '-vf', filters, '-loop', '0', out]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${out}  ${(statSync(out).size / 1e6).toFixed(2)} MB  (${n} frames)`);
}

const openTree = (page) =>
  page.evaluate(() => document.querySelectorAll('.client-group').forEach((g) => g.classList.add('open')));

const setTheme = (page, theme) =>
  page.evaluate((t) => {
    localStorage.setItem('contrast-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

const browser = await puppeteer.launch({ headless: true, defaultViewport: VIEW, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

try {
  // ---------------------------------------------------------- 1. run an audit
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await setTheme(page, 'dark');
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('#composer');
  console.log('recording…');

  await record(page, 'new-audit', async () => {
    await sleep(700);
    for (const ch of 'www.w3.org/WAI/demos/bad/before/home.html') {
      await page.type('#url', ch, { delay: 18 });
    }
    await sleep(600);
    await page.click('#start');
    // until the live browser panel has painted and the console is flowing
    await page.waitForSelector('#screen.live', { timeout: 90000 }).catch(() => {});
    await sleep(9000);
  }, { speed: 2.2 });

  // wait for the job to finish before the next scene
  await page.waitForFunction(() => document.querySelector('#job-status')?.textContent !== 'running', { timeout: 240000 }).catch(() => {});
  await sleep(1500);

  // ------------------------------------------------------------- 2. findings
  await page.reload({ waitUntil: 'networkidle0' });
  await openTree(page);
  await page.click('.run-item');
  await sleep(1500);
  await page.click('#tab-findings');
  await page.waitForSelector('#list .finding');

  await record(page, 'findings', async () => {
    await sleep(900);
    for (const ch of 'contrast') await page.type('#q', ch, { delay: 90 });
    await sleep(1200);
    await page.click('#list .finding .head');
    await sleep(2600);
    await page.evaluate(() => window.scrollBy({ top: 320, behavior: 'smooth' }));
    await sleep(1800);
  }, { speed: 1.35 });

  // ------------------------------------------------------ 3. history + compare
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#tab-history');
  await page.waitForSelector('.rail .node');

  await record(page, 'history-compare', async () => {
    await sleep(2200);
    await page.click('#tab-compare');
    await page.waitForSelector('.diff-col .rule-row', { timeout: 30000 }).catch(() => {});
    await sleep(2200);
    const rows = await page.$$('.diff-col .rule-row');
    if (rows[0]) await rows[0].click();
    await sleep(2400);
  }, { speed: 1.25 });

  // ------------------------------------------------------------ 4. organising
  await page.click('#tab-overview');
  await sleep(600);

  await record(page, 'organise', async () => {
    await sleep(700);
    const el = await page.$('.client-toggle');
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.waitForSelector('.ctx', { timeout: 5000 }).catch(() => {});
    await sleep(2200);
    const items = await page.$$eval('.ctx button', (n) => n.map((x) => x.textContent.trim()));
    const pin = items.findIndex((t) => /Pin to top/.test(t));
    if (pin >= 0) await page.evaluate((i) => document.querySelectorAll('.ctx button')[i].click(), pin);
    await sleep(2000);
    // then the command palette
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.waitForSelector('.palette', { timeout: 5000 }).catch(() => {});
    await sleep(700);
    for (const ch of 'hist') await page.type('#pal-q', ch, { delay: 110 });
    await sleep(1400);
    await page.keyboard.press('Enter');
    await sleep(1800);
  }, { speed: 1.3 });

  // ------------------------------------------------------------- 5. stills
  const shot = async (name, prep) => {
    await prep();
    await sleep(900);
    await page.screenshot({ path: join(DOCS, `${name}.png`) });
    console.log(`  ${join(DOCS, name)}.png`);
  };

  await shot('shot-dark-overview', async () => {
    await page.click('#tab-overview');
  });
  await shot('shot-light-composer', async () => {
    await setTheme(page, 'light');
    await page.click('#new-audit');
  });
  await shot('shot-settings', async () => {
    await setTheme(page, 'dark');
    await page.click('#tab-settings');
    await page.waitForSelector('#s-key');
  });
} finally {
  await browser.close();
  console.log('\ndocs/:', readdirSync(DOCS).join(', '));
}

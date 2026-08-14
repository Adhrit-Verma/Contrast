// Mirrors the job's real browser into the dashboard, and forwards clicks and
// keystrokes back. The job runs as a child process and owns the browser, so we
// re-attach over its WebSocket endpoint (printed as `[browser-ws] …`) instead of
// trying to share an object across processes.
//
// This is how an auditor signs in without leaving the app: the pipeline stalls,
// the login page appears here, they type into it, and the run continues.
import puppeteer from 'puppeteer';

const sessions = new Map(); // jobId -> { browser, page, cdp, subs:Set, watching }
const POLL_MS = 900;

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function attach(jobId, wsEndpoint) {
  let s = sessions.get(jobId);
  if (s) return s;
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  s = { browser, page: null, cdp: null, subs: new Set(), watching: null };
  sessions.set(jobId, s);

  browser.on('disconnected', () => {
    for (const res of s.subs) res.end();
    sessions.delete(jobId);
  });

  // Follow the newest *real* page: during login that is the unguarded login tab,
  // during a crawl it is the tab being scanned. pages() is not in creation order
  // and the launch tab sits there as about:blank, so filter it out explicitly.
  const follow = async () => {
    if (!sessions.has(jobId)) return;
    try {
      const pages = (await browser.pages()).filter((p) => !p.isClosed());
      const real = pages.filter((p) => p.url() && p.url() !== 'about:blank');
      const target = real.at(-1) ?? pages.at(-1);
      if (target && target !== s.page) await bind(s, target);
      // A page that is merely sitting there never repaints, so the screencast
      // goes silent. Re-seed a frame so a login screen is actually visible.
      else if (s.page && Date.now() - (s.lastFrame ?? 0) > POLL_MS) await seedFrame(s);
    } catch {}
    // Poll fast until the first frame lands, then back off — "Connecting to the
    // browser…" sitting there for a second and a half looks broken.
    s.watching = setTimeout(follow, s.lastFrame ? 1500 : 400);
  };
  await follow();
  return s;
}

async function bind(s, page) {
  try {
    if (s.cdp) await s.cdp.detach().catch(() => {});
  } catch {}
  s.page = page;
  s.cdp = await page.createCDPSession();
  await s.cdp.send('Page.enable');
  // A backgrounded or occluded tab is throttled and stops emitting screencast
  // frames — which is exactly why the panel used to sit on "Connecting…" when
  // the audit ran in a headed window behind the dashboard.
  await s.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  s.cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    s.lastFrame = Date.now();
    for (const res of s.subs) send(res, { type: 'frame', data, metadata, url: page.url() });
    await s.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  // Deliberately modest: this is a supervision view, not a video feed. Smaller
  // frames keep the dashboard's main thread free for the app itself.
  await s.cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 45,
    maxWidth: 900,
    maxHeight: 700,
    everyNthFrame: 3,
  });
  for (const res of s.subs) send(res, { type: 'page', url: page.url() });
  await seedFrame(s);
}

/** One-off capture, for when nothing on the page is moving. */
async function seedFrame(s) {
  if (!s.cdp || !s.page) return;
  const shot = await s.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }).catch(() => null);
  if (!shot) return;
  const metadata = await s.page
    .evaluate(() => ({ deviceWidth: innerWidth, deviceHeight: innerHeight, scrollOffsetY: 0, pageScaleFactor: 1 }))
    .catch(() => null);
  s.lastFrame = Date.now();
  for (const res of s.subs) send(res, { type: 'frame', data: shot.data, metadata, url: s.page.url() });
}

/** SSE stream of JPEG frames for one job's browser. */
export async function streamBrowser(jobId, wsEndpoint, req, res) {
  if (!wsEndpoint) return false;
  const s = await attach(jobId, wsEndpoint).catch(() => null);
  if (!s) return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  s.subs.add(res);
  send(res, { type: 'page', url: s.page?.url() ?? '' });
  req.on('close', () => s.subs.delete(res));
  return true;
}

/**
 * Forward one input event. Coordinates arrive in page CSS pixels — the client
 * scales them from the rendered frame before sending.
 */
export async function forwardInput(jobId, ev) {
  const s = sessions.get(jobId);
  if (!s?.cdp) return false;
  const cdp = s.cdp;
  try {
    if (ev.kind === 'click') {
      const base = { x: ev.x, y: ev.y, button: 'left', clickCount: ev.clickCount ?? 1, modifiers: ev.modifiers ?? 0 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    } else if (ev.kind === 'move') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y, button: 'none' });
    } else if (ev.kind === 'scroll') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX ?? 0, deltaY: ev.deltaY ?? 0 });
    } else if (ev.kind === 'text') {
      // insertText handles IME, paste and non-ASCII in one call.
      await cdp.send('Input.insertText', { text: ev.text });
    } else if (ev.kind === 'key') {
      const common = { key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode, modifiers: ev.modifiers ?? 0 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    } else if (ev.kind === 'navigate' && /^https?:/.test(ev.url ?? '')) {
      await s.page.goto(ev.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function detachBrowser(jobId) {
  const s = sessions.get(jobId);
  if (!s) return;
  clearTimeout(s.watching);
  for (const res of s.subs) res.end();
  // Only ever disconnect our client — never close the job's browser.
  s.browser.disconnect().catch(() => {});
  sessions.delete(jobId);
}
